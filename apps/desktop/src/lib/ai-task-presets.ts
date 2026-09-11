import {
  AI_TASK_DEFINITIONS,
  type AiTaskKey,
} from "./ai-task-preferences";
import type {
  AiTaskContextPreference,
  AiTaskPreferences,
} from "./tauri-client";

type AiTaskPresetOverride = {
  temperature: number;
  maxOutputTokens: number;
  context: Partial<AiTaskContextPreference>;
};

export type AiTaskPreset = {
  id: string;
  label: string;
  description: string;
  tasks: Record<AiTaskKey, AiTaskPresetOverride>;
};

export const AI_TASK_PRESETS: AiTaskPreset[] = [
  {
    id: "serialized",
    label: "长篇连载",
    description: "强化推进速度、章末钩子和持续产出，适合长篇网文。",
    tasks: {
      workDesign: { temperature: 0.5, maxOutputTokens: 4096, context: { inputTokenBudget: 28672 } },
      outline: { temperature: 0.65, maxOutputTokens: 7168, context: { inputTokenBudget: 36864 } },
      volumePlanning: { temperature: 0.6, maxOutputTokens: 7168, context: { inputTokenBudget: 36864 } },
      chapterSplit: { temperature: 0.35, maxOutputTokens: 5120, context: { inputTokenBudget: 28672 } },
      writing: { temperature: 0.95, maxOutputTokens: 8192, context: { inputTokenBudget: 57344 } },
      knowledgeExtraction: { temperature: 0.1, maxOutputTokens: 4096, context: { inputTokenBudget: 28672 } },
    },
  },
  {
    id: "mystery",
    label: "悬疑推理",
    description: "降低情节漂移，强调线索、因果和前后一致性。",
    tasks: {
      workDesign: { temperature: 0.35, maxOutputTokens: 4608, context: { includeReferenceContent: true, inputTokenBudget: 32768 } },
      outline: { temperature: 0.45, maxOutputTokens: 7168, context: { includeProjectKnowledge: true, inputTokenBudget: 40960 } },
      volumePlanning: { temperature: 0.5, maxOutputTokens: 7168, context: { includeProjectKnowledge: true, inputTokenBudget: 40960 } },
      chapterSplit: { temperature: 0.2, maxOutputTokens: 5120, context: { includeProjectKnowledge: true, inputTokenBudget: 32768 } },
      writing: { temperature: 0.7, maxOutputTokens: 8192, context: { includeCurrentDraft: true, includeChapterPlan: true, inputTokenBudget: 57344 } },
      knowledgeExtraction: { temperature: 0.05, maxOutputTokens: 4096, context: { inputTokenBudget: 32768 } },
    },
  },
  {
    id: "relationship",
    label: "情感关系",
    description: "提高人物关系、情绪层次和关系转折的表达弹性。",
    tasks: {
      workDesign: { temperature: 0.55, maxOutputTokens: 4096, context: { inputTokenBudget: 28672 } },
      outline: { temperature: 0.7, maxOutputTokens: 6144, context: { includeProjectKnowledge: true, inputTokenBudget: 36864 } },
      volumePlanning: { temperature: 0.65, maxOutputTokens: 7168, context: { includeProjectKnowledge: true, inputTokenBudget: 36864 } },
      chapterSplit: { temperature: 0.35, maxOutputTokens: 4096, context: { includeProjectKnowledge: true, inputTokenBudget: 28672 } },
      writing: { temperature: 0.85, maxOutputTokens: 8192, context: { includeCurrentDraft: true, includeChapterPlan: true, inputTokenBudget: 57344 } },
      knowledgeExtraction: { temperature: 0.15, maxOutputTokens: 4096, context: { inputTokenBudget: 28672 } },
    },
  },
  {
    id: "science-fiction",
    label: "科幻设定",
    description: "强化规则一致性、世界约束和跨章节知识检索。",
    tasks: {
      workDesign: { temperature: 0.35, maxOutputTokens: 5120, context: { includeReferenceContent: true, inputTokenBudget: 36864 } },
      outline: { temperature: 0.5, maxOutputTokens: 7168, context: { includeProjectKnowledge: true, inputTokenBudget: 40960 } },
      volumePlanning: { temperature: 0.5, maxOutputTokens: 7168, context: { includeProjectKnowledge: true, inputTokenBudget: 40960 } },
      chapterSplit: { temperature: 0.25, maxOutputTokens: 5120, context: { includeProjectKnowledge: true, inputTokenBudget: 32768 } },
      writing: { temperature: 0.8, maxOutputTokens: 8192, context: { includeProjectKnowledge: true, inputTokenBudget: 57344 } },
      knowledgeExtraction: { temperature: 0.05, maxOutputTokens: 5120, context: { inputTokenBudget: 36864 } },
    },
  },
  {
    id: "realism",
    label: "现实题材",
    description: "控制夸张表达，更重视人物动机、现实因果和稳定文风。",
    tasks: {
      workDesign: { temperature: 0.5, maxOutputTokens: 4096, context: { includeReferenceContent: true, inputTokenBudget: 28672 } },
      outline: { temperature: 0.65, maxOutputTokens: 6144, context: { includeProjectKnowledge: true, inputTokenBudget: 36864 } },
      volumePlanning: { temperature: 0.6, maxOutputTokens: 6144, context: { includeProjectKnowledge: true, inputTokenBudget: 36864 } },
      chapterSplit: { temperature: 0.4, maxOutputTokens: 4096, context: { includeProjectKnowledge: true, inputTokenBudget: 28672 } },
      writing: { temperature: 0.8, maxOutputTokens: 8192, context: { includeCurrentDraft: true, includeChapterPlan: true, inputTokenBudget: 57344 } },
      knowledgeExtraction: { temperature: 0.15, maxOutputTokens: 4096, context: { inputTokenBudget: 28672 } },
    },
  },
  {
    id: "fast-draft",
    label: "快速草稿",
    description: "压缩上下文和单次输出，优先快速形成可修改的第一版。",
    tasks: {
      workDesign: { temperature: 0.55, maxOutputTokens: 2560, context: { includeProjectKnowledge: false, inputTokenBudget: 16384 } },
      outline: { temperature: 0.7, maxOutputTokens: 4096, context: { includeProjectKnowledge: false, inputTokenBudget: 20480 } },
      volumePlanning: { temperature: 0.65, maxOutputTokens: 4096, context: { includeProjectKnowledge: false, inputTokenBudget: 20480 } },
      chapterSplit: { temperature: 0.4, maxOutputTokens: 2560, context: { includeProjectKnowledge: false, inputTokenBudget: 16384 } },
      writing: { temperature: 1, maxOutputTokens: 6144, context: { includeCurrentDraft: false, includeProjectKnowledge: false, inputTokenBudget: 32768 } },
      knowledgeExtraction: { temperature: 0.15, maxOutputTokens: 3072, context: { includeProjectKnowledge: false, inputTokenBudget: 16384 } },
    },
  },
  {
    id: "final-polish",
    label: "精修定稿",
    description: "提高上下文覆盖和输出空间，适合已有草稿后的集中精修。",
    tasks: {
      workDesign: { temperature: 0.35, maxOutputTokens: 5120, context: { includeReferenceContent: true, inputTokenBudget: 36864 } },
      outline: { temperature: 0.5, maxOutputTokens: 8192, context: { includeProjectKnowledge: true, inputTokenBudget: 49152 } },
      volumePlanning: { temperature: 0.5, maxOutputTokens: 8192, context: { includeProjectKnowledge: true, inputTokenBudget: 49152 } },
      chapterSplit: { temperature: 0.25, maxOutputTokens: 6144, context: { includeProjectKnowledge: true, inputTokenBudget: 36864 } },
      writing: { temperature: 0.7, maxOutputTokens: 12288, context: { includeCurrentDraft: true, includeChapterPlan: true, includeProjectKnowledge: true, inputTokenBudget: 65536 } },
      knowledgeExtraction: { temperature: 0.05, maxOutputTokens: 5120, context: { includeProjectKnowledge: true, inputTokenBudget: 40960 } },
    },
  },
];

export function applyAiTaskPreset(
  preferences: AiTaskPreferences,
  preset: AiTaskPreset,
): AiTaskPreferences {
  return Object.fromEntries(
    AI_TASK_DEFINITIONS.map(({ key }) => {
      const current = preferences[key];
      const override = preset.tasks[key];
      return [
        key,
        {
          ...current,
          temperature: override.temperature,
          maxOutputTokens: override.maxOutputTokens,
          prompt: {
            ...current.prompt,
            context: {
              ...current.prompt.context,
              ...override.context,
            },
          },
        },
      ];
    }),
  ) as AiTaskPreferences;
}
