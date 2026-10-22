import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { nodePlanId } from "./project-workspace-utils";
import { planningReviewIsCurrent } from "./planning-review";
import { outlineSourcesChanged } from "./outline-steps";

export type PreparationItem = {
  id: string;
  sectionId: string | null;
  title: string;
  question: string;
  placeholder: string;
  required: boolean;
  kind?: "OUTLINE" | "OUTLINE_STEP" | "CHAPTER";
  guidance?: string;
};
export type PreparationStage = { id: string; title: string; outcome: string; items: PreparationItem[] };
export type PreparationStatus = "empty" | "draft" | "review" | "confirmed" | "deferred";

export function preparationStatus(section?: PlanningSection, sections?: PlanningSection[]): PreparationStatus {
  if (!section) return "empty";
  if (["UNKNOWN", "DEFERRED", "AUTHOR_RESERVED"].includes(section.storyState)) return "deferred";
  if (section.pendingContent.trim()) return "review";
  if (sections && outlineSourcesChanged(section, sections)) return "review";
  if (sections && !planningReviewIsCurrent(section, sections)) return "review";
  if (section.content.trim() && ["CONFIRMED", "LOCKED"].includes(section.storyState)) return "confirmed";
  return section.content.trim() ? "draft" : "empty";
}

export const preparationStatusLabels: Record<PreparationStatus, string> = {
  empty: "未开始", draft: "草稿", review: "待确认", confirmed: "已确认", deferred: "暂不决定",
};

export function buildPreparationStages(nodes: PlanNode[]): PreparationStage[] {
  const active = nodes.filter((node) => !node.archived);
  const outline = active.find((node) => node.kind === "OUTLINE");
  // Match the writing workspace's volume/chapter order, not the last visited chapter.
  const chapter = active.find((node) => node.kind === "CHAPTER");
  return [
    { id: "story", title: "明确故事", outcome: "故事的基本方向", items: [
      { id: "premise", sectionId: "seed-premise", title: "故事核心", required: true,
        question: "这个故事讲什么？",
        placeholder: "用一两句话说说你的故事。" },
      { id: "genre", sectionId: "seed-genre", title: "题材", required: true,
        question: "你想写什么题材？",
        placeholder: "例如：都市悬疑。" },
      { id: "promise", sectionId: "seed-genre-promise", title: "阅读期待", required: true,
        question: "你最想让读者感受到什么？",
        placeholder: "例如：一步步接近真相的紧张感。" },
      { id: "protagonist", sectionId: "engine-protagonist", title: "主角", required: true,
        question: "主角是个怎样的人？",
        placeholder: "用几句话介绍主角。" },
      { id: "motivation", sectionId: "engine-motivation", title: "行动动机", required: true,
        question: "什么让主角必须行动？",
        placeholder: "例如：只有找到失踪的妹妹，他才能放下自责。" },
    ] },
    { id: "setting", title: "建立关键设定", outcome: "故事的规则与阻力", items: [
      { id: "rules", sectionId: "frame-setting", title: "故事规则", required: true,
        question: "哪条规则最影响人物的行动？",
        placeholder: "先写最重要的一条规则。" },
      { id: "conflict", sectionId: "engine-antagonism", title: "主要阻力", required: true,
        question: "主角最大的阻碍是什么？",
        placeholder: "例如：掌握线索的人拒绝开口。" },
      { id: "stakes", sectionId: "engine-stakes", title: "失败代价", required: true,
        question: "如果失败，主角会失去什么？",
        placeholder: "写下最重要的损失。" },
      { id: "relationship", sectionId: "cast-core-relationship", title: "关键关系", required: false,
        question: "谁最影响主角的选择？",
        placeholder: "说说这段关系。" },
    ] },
    { id: "outline", title: "审定主线大纲", outcome: "一条连贯的故事主线", items: [
      { id: "outline", sectionId: outline ? nodePlanId(outline.id) : null, title: "主线大纲", required: true, kind: "OUTLINE",
        question: "这个故事的主线怎样发展？",
        placeholder: "顺着主角的行动，简要写出故事经过。" },
      { id: "ending", sectionId: "engine-ending", title: "结局方向", required: false,
        question: "你希望故事怎样结束？",
        placeholder: "写下目前倾向的结局，也可以暂不决定。" },
    ] },
    { id: "opening", title: "准备开篇", outcome: "第一章的核心事件", items: [
      { id: "opening", sectionId: chapter ? nodePlanId(chapter.id) : null, title: "开篇章节计划", required: true, kind: "CHAPTER",
        question: "第一章发生什么？",
        placeholder: "围绕一件主要事件，写下开篇的打算。" },
    ] },
  ];
}

export function preparationProgress(stages: PreparationStage[], sections: PlanningSection[]) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const required = stages.flatMap((stage) => stage.items).filter((item) => item.required);
  const missing = required.filter((item) => !item.sectionId || preparationStatus(byId.get(item.sectionId), sections) !== "confirmed");
  return { total: required.length, confirmed: required.length - missing.length, missing, ready: missing.length === 0 };
}

export function preparationPrerequisites(stages: PreparationStage[], itemId: string, sections: PlanningSection[]) {
  const index = stages.findIndex((stage) => stage.items.some((item) => item.id === itemId));
  const missing = preparationProgress(stages, sections).missing;
  return stages.slice(0, Math.max(0, index)).flatMap((stage) => stage.items)
    .filter((item) => missing.some((entry) => entry.id === item.id));
}
