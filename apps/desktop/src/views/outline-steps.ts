import type { PlanningSection } from "../lib/tauri-client";
import type { PreparationItem } from "./creation-preparation";
import { planningReviewIsCurrent } from "./planning-review";

const sourcePrefix = "outline-sources:v1:";
const steps = [
  { id: "inciting", title: "引发事件", question: "什么事打破了主角的生活？",
    placeholder: "写一个迫使主角介入的具体事件。",
    guidance: "写清事件发生的情境、主角受到的影响，以及他为什么无法置身事外。" },
  { id: "action", title: "初次行动", question: "主角首先做了什么？",
    placeholder: "承接上一段，写主角第一次主动行动。",
    guidance: "承接引发事件，写清主角的具体目标、选择的行动和直接结果。" },
  { id: "escalation", title: "冲突升级", question: "这次行动惹出了什么麻烦？",
    placeholder: "让新的困难来自前面的行动。",
    guidance: "写清前次行动如何招致反击或新困难，主角如何应对，以及局面为什么变得更难。" },
  { id: "turning", title: "关键转折", question: "什么迫使主角改变计划？",
    placeholder: "写一次有铺垫、会改变方向的转折。",
    guidance: "写清前文的铺垫、使原计划失效的新情况，以及主角为改变方向付出的代价。" },
  { id: "resolution", title: "高潮收束", question: "主角最后如何面对核心冲突？",
    placeholder: "让最后的选择回应前面的经历。",
    guidance: "承接转折，写清主角的最终选择、核心冲突的结果和人物变化；尚未决定的结局保持待定。" },
];

export function buildOutlineSteps(sectionId: string): PreparationItem[] {
  const nodeId = sectionId.startsWith("plan-node:") ? sectionId.slice("plan-node:".length) : sectionId;
  return steps.map((step) => ({
    ...step, sectionId: `outline-step-${nodeId}-${step.id}`, primary: true, kind: "OUTLINE_STEP",
  }));
}

export function assembleOutline(items: PreparationItem[], sections: PlanningSection[]) {
  return items.map((item) => {
    const section = sections.find((entry) => entry.id === item.sectionId);
    return `## ${item.title}\n\n${section?.content.trim() ?? ""}`;
  }).join("\n\n");
}

export function withOutlineSources(references: string[], items: PreparationItem[], sections: PlanningSection[]) {
  const sources = items.map((item) => {
    const section = sections.find((entry) => entry.id === item.sectionId);
    return { id: item.sectionId, version: section?.version ?? 0 };
  });
  return [...references.filter((entry) => !entry.startsWith(sourcePrefix)), sourcePrefix + JSON.stringify(sources)];
}

export function outlineHasSources(section?: PlanningSection) {
  return Boolean(section?.references.some((entry) => entry.startsWith(sourcePrefix)));
}

export function outlineSourcesChanged(section: PlanningSection | undefined, sections: PlanningSection[]) {
  const reference = section?.references.find((entry) => entry.startsWith(sourcePrefix));
  if (!reference) return false;
  try {
    const sources: unknown = JSON.parse(reference.slice(sourcePrefix.length));
    if (!Array.isArray(sources)) return true;
    return sources.some((source: unknown) => {
      if (!source || typeof source !== "object" || !("id" in source) || !("version" in source)) return true;
      const current = sections.find((entry) => entry.id === source.id);
      return !current || (current.version ?? 0) !== source.version || Boolean(current.pendingContent.trim())
        || !current.content.trim() || !["CONFIRMED", "LOCKED"].includes(current.storyState)
        || !planningReviewIsCurrent(current, sections);
    });
  } catch { return true; }
}
