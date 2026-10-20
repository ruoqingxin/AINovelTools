import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { nodePlanId } from "./project-workspace-utils";

export type PreparationItem = {
  id: string;
  sectionId: string | null;
  title: string;
  question: string;
  placeholder: string;
  required: boolean;
  kind?: "OUTLINE" | "CHAPTER";
};
export type PreparationStage = { id: string; title: string; items: PreparationItem[] };
export type PreparationStatus = "empty" | "draft" | "review" | "confirmed" | "deferred";

export function preparationStatus(section?: PlanningSection): PreparationStatus {
  if (!section) return "empty";
  if (["UNKNOWN", "DEFERRED", "AUTHOR_RESERVED"].includes(section.storyState)) return "deferred";
  if (section.pendingContent.trim()) return "review";
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
    { id: "story", title: "明确故事", items: [
      { id: "premise", sectionId: "seed-premise", title: "故事核心", required: true,
        question: "谁在什么处境下，必须做成什么事？",
        placeholder: "主角原本的生活是……\n打破平静的事件是……\n他必须……否则……" },
      { id: "promise", sectionId: "seed-genre-promise", title: "题材与阅读期待", required: true,
        question: "你想写哪类故事，最想让读者感受到什么？",
        placeholder: "题材：都市悬疑 / 奇幻冒险 / 现实成长……\n主要阅读体验：抽丝剥茧、逆境翻盘、关系变化……" },
      { id: "protagonist", sectionId: "engine-protagonist", title: "主角与动机", required: true,
        question: "主角是谁，他为什么非要行动不可？",
        placeholder: "姓名与身份：……\n眼前目标：……\n真正的需要或弱点：……\n无法置身事外的原因：……" },
    ] },
    { id: "setting", title: "建立关键设定", items: [
      { id: "rules", sectionId: "frame-setting", title: "故事规则与边界", required: true,
        question: "哪些规则和限制会真正影响人物的选择？",
        placeholder: "故事发生在哪里：……\n人物能做什么、不能做什么：……\n能力、资源或现实条件的限制：……" },
      { id: "stakes", sectionId: "engine-stakes", title: "冲突与代价", required: true,
        question: "谁或什么阻挡主角，失败会失去什么？",
        placeholder: "主要阻力：……\n行动必须付出的代价：……\n失败或不行动的后果：……" },
      { id: "relationship", sectionId: "cast-core-relationship", title: "关键人物关系", required: false,
        question: "哪段关系会影响主角的关键选择？",
        placeholder: "关系双方：……\n相互需要与冲突：……\n希望发生的变化：……" },
    ] },
    { id: "outline", title: "确定故事走向", items: [
      { id: "outline", sectionId: outline ? nodePlanId(outline.id) : null, title: "主线大纲", required: true, kind: "OUTLINE",
        question: "从开局到阶段高潮，故事的因果链是什么？",
        placeholder: "开局事件：……\n主角的第一次选择：……\n阻力与局面升级：……\n关键转折：……\n阶段高潮与后续方向：……" },
      { id: "ending", sectionId: "engine-ending", title: "结局方向", required: false,
        question: "主角最后可能成为什么样的人？",
        placeholder: "主线可能如何收束：……\n主角得到与失去什么：……\n还想保留开放的部分：……" },
    ] },
    { id: "opening", title: "准备开篇", items: [
      { id: "opening", sectionId: chapter ? nodePlanId(chapter.id) : null, title: "开篇章节计划", required: true, kind: "CHAPTER",
        question: "第一章发生什么，为什么值得读下去？",
        placeholder: "开场情境与视角人物：……\n本章目标：……\n关键事件与冲突：……\n人物的选择与局面变化：……\n章末悬念：……" },
    ] },
  ];
}

export function preparationProgress(stages: PreparationStage[], sections: PlanningSection[]) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const required = stages.flatMap((stage) => stage.items).filter((item) => item.required);
  const missing = required.filter((item) => !item.sectionId || preparationStatus(byId.get(item.sectionId)) !== "confirmed");
  return { total: required.length, confirmed: required.length - missing.length, missing, ready: missing.length === 0 };
}
