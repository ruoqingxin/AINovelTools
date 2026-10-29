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
  primary: boolean;
  kind?: "OUTLINE" | "OUTLINE_STEP" | "CHAPTER";
  guidance?: string;
  entityTypes?: Array<"CHARACTER" | "LOCATION" | "FACTION" | "ITEM" | "CONCEPT">;
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
    { id: "story", title: "故事概念", outcome: "故事的基本方向", items: [
      { id: "premise", sectionId: "seed-premise", title: "故事概念", primary: true,
        question: "这个故事讲什么？",
        placeholder: "用一两句话说说你的故事。",
        guidance: "只概述故事，不展开人物档案、世界规则或完整大纲。" },
      { id: "genre", sectionId: "seed-genre", title: "题材", primary: false,
        question: "你想写什么题材？",
        placeholder: "例如：都市悬疑。" },
      { id: "promise", sectionId: "seed-genre-promise", title: "阅读期待", primary: false,
        question: "你最想让读者感受到什么？",
        placeholder: "例如：一步步接近真相的紧张感。",
        guidance: "记录读者追随故事的期待，不重复本书偏好中的语言风格或整体基调。" },
      { id: "hook", sectionId: "seed-hook", title: "独特看点", primary: false,
        question: "这个故事最吸引你的是什么？", placeholder: "记录一个独特的身份、情境或关系。" },
    ] },
    { id: "characters", title: "核心人物", outcome: "人物在故事中的位置", items: [
      { id: "protagonist", sectionId: "engine-protagonist", title: "核心人物", primary: true,
        question: "故事围绕怎样的人展开？",
        placeholder: "简述主角或核心人物在故事中的处境与作用。",
        guidance: "只讨论人物定位与叙事作用。身份、经历、能力等具体事实沿用关联人物资料，不另建一份人物档案。",
        entityTypes: ["CHARACTER"] },
      { id: "relationship", sectionId: "cast-core-relationship", title: "关键关系", primary: false,
        question: "谁最影响人物的选择？", placeholder: "记录关系对人物选择的影响，不重复双方档案。", entityTypes: ["CHARACTER"] },
      { id: "supporting", sectionId: "cast-supporting", title: "配角作用", primary: false,
        question: "配角为故事带来了什么？", placeholder: "记录配角的叙事作用，具体资料关联人物。", entityTypes: ["CHARACTER"] },
      { id: "arcs", sectionId: "cast-arcs", title: "人物变化", primary: false,
        question: "人物会经历怎样的变化？", placeholder: "只写变化方向与关键选择，秘密的具体事实保留在设定中。", entityTypes: ["CHARACTER"] },
    ] },
    { id: "motivation", title: "目标与动机", outcome: "人物想做什么、为什么在意", items: [
      { id: "motivation", sectionId: "engine-motivation", title: "目标与动机", primary: true,
        question: "人物想做成什么，为什么在意？",
        placeholder: "例如：他想找到失踪的妹妹，以弥补当年的失约。", entityTypes: ["CHARACTER"] },
    ] },
    { id: "conflict", title: "主要矛盾", outcome: "让故事持续发展的张力", items: [
      { id: "conflict", sectionId: "engine-antagonism", title: "主要矛盾", primary: true,
        question: "什么让人物的愿望难以实现？",
        placeholder: "可以是人与人、环境或内心的矛盾，不一定有反派。" },
      { id: "stakes", sectionId: "engine-stakes", title: "风险与代价", primary: false,
        question: "这件事为什么重要？",
        placeholder: "不行动或事与愿违时，人物的生活会怎样变化？" },
      { id: "rules", sectionId: "frame-setting", title: "关键设定", primary: false,
        question: "哪条规则最影响人物的行动？",
        placeholder: "仅记录还在推敲的规则；已确定的规则直接关联设定。",
        guidance: "优先沿用关联设定，不重复编写规则全文。没有特殊规则可以暂不决定。",
        entityTypes: ["CONCEPT", "LOCATION", "FACTION", "ITEM"] },
      { id: "history", sectionId: "frame-history", title: "矛盾来源", primary: false,
        question: "眼前的矛盾是怎样形成的？", placeholder: "只写与当前故事有关的因果，历史和势力资料引用设定。", entityTypes: ["FACTION", "CONCEPT", "LOCATION"] },
    ] },
    { id: "outline", title: "主线方向", outcome: "可以继续细化的故事走向", items: [
      { id: "outline", sectionId: outline ? nodePlanId(outline.id) : null, title: "主线方向", primary: true, kind: "OUTLINE",
        question: "这个故事的主线怎样发展？",
        placeholder: "先写目前想到的故事走向，尚未确定的部分可以留白。",
        guidance: "这就是大纲中的同一份内容，可以先粗后细，不要求确定全书结局。" },
      { id: "ending", sectionId: "engine-ending", title: "结局方向", primary: false,
        question: "你希望故事怎样结束？",
        placeholder: "写下目前倾向的结局，也可以暂不决定。" },
      { id: "narrative", sectionId: "frame-narrative", title: "信息揭示", primary: false,
        question: "哪些信息要在何时让读者知道？", placeholder: "记录揭示顺序与关键悬念；视角和节奏偏好沿用本书偏好。" },
    ] },
    { id: "opening", title: "开篇事件", outcome: "第一章从哪里开始", items: [
      { id: "opening", sectionId: chapter ? nodePlanId(chapter.id) : null, title: "开篇事件", primary: true, kind: "CHAPTER",
        question: "第一章发生什么？",
        placeholder: "一个情境或事件即可，不必先完成全书大纲。" },
    ] },
  ];
}
