import type { CoauthorDocument, EntityType, PlanNodeKind, SummaryMaterial, WritingCard } from "./tauri-client";
import { sourceReturnTo } from "./manuscript-source";

export const contentCategories = {
  UNCLASSIFIED: { label: "待归类", description: "尚未确定用途，不能作为正式设定或大纲采用" },
  SETTING: { label: "设定", description: "故事世界中的身份、事实、规则与限制" },
  OUTLINE: { label: "大纲", description: "作者计划的情节、结构与章节安排" },
  MANUSCRIPT: { label: "正文", description: "实际呈现给读者的故事文本" },
  RECORD: { label: "剧情记录", description: "有来源依据的事件、关系、人物认知与伏笔状态" },
  REFERENCE: { label: "辅助参考", description: "摘要记忆、写作规则与技巧，不直接代表故事事实" },
} as const;
export type ContentCategory = keyof typeof contentCategories;
export const coauthorKindLabels = {
  UNCLASSIFIED: contentCategories.UNCLASSIFIED.label, SETTING: contentCategories.SETTING.label,
  OUTLINE: contentCategories.OUTLINE.label, MANUSCRIPT: contentCategories.MANUSCRIPT.label,
} as const;
export type ContentIdentity = { category: ContentCategory; subtype: string };

export const entityTypeLabels: Record<EntityType, string> = {
  CHARACTER: "人物", LOCATION: "地点", FACTION: "阵营", ITEM: "物品", CONCEPT: "世界规则与概念",
};
export const recordTypeLabels = {
  relations: "关系", events: "事件", beliefs: "人物认知", foreshadowings: "伏笔",
} as const;
export const writingCardTypeLabels: Record<WritingCard["cardType"], string> = {
  STYLE_RULE: "风格规则", TECHNIQUE: "写作技巧",
};

export function entityIdentity(type: EntityType): ContentIdentity {
  return { category: "SETTING", subtype: entityTypeLabels[type] };
}
export function planIdentity(kind: PlanNodeKind): ContentIdentity {
  const subtypes: Record<PlanNodeKind, string> = {
    WORK_DESIGN: "创作准备", OUTLINE: "全书大纲", VOLUME_MANAGER: "分卷与章节结构",
    VOLUME: "分卷规划", CHAPTER: "章节细纲", SCENE: "场景安排",
  };
  return { category: kind === "WORK_DESIGN" ? "UNCLASSIFIED" : "OUTLINE", subtype: subtypes[kind] };
}
export function summaryIdentity(item: Pick<SummaryMaterial, "generationMode">): ContentIdentity {
  const labels: Record<string, string> = {
    EXTRACTIVE_AUTO: "章节记忆", EXTRACTIVE_AUTO_PROJECT: "作品概览", EXTRACTIVE_AUTO_SETTINGS: "设定概览",
  };
  return { category: "REFERENCE", subtype: labels[item.generationMode] ?? "参考摘要" };
}
export function planningSectionIdentity(id: string): ContentIdentity {
  if (id === "seed-tone") return { category: "REFERENCE", subtype: "本书偏好" };
  if (id === "frame-setting") return { category: "SETTING", subtype: "世界规则与限制" };
  if (id.startsWith("plan-node:") || id.startsWith("chapter-split-")) return { category: "OUTLINE", subtype: "情节规划" };
  // Legacy preparation notes can mix facts and intended plot. Do not silently recategorize them.
  return { category: "UNCLASSIFIED", subtype: "创作准备" };
}
export function draftIdentity(document: Pick<CoauthorDocument, "kind">): ContentIdentity {
  return { category: document.kind, subtype: document.kind === "SETTING" ? "世界规则与概念" : "工作稿" };
}
export function identityLabel(identity: ContentIdentity) {
  return `${contentCategories[identity.category].label} · ${identity.subtype}`;
}
export function parseContentOrigin(text: string | null | undefined, projectId: string | undefined) {
  if (!text || !projectId) return null;
  try {
    const value = JSON.parse(text);
    if (value?.kind !== "content-target" || value.projectId !== projectId || !Object.prototype.hasOwnProperty.call(contentCategories, value.category)
      || typeof value.subtype !== "string" || typeof value.title !== "string" || typeof value.key !== "string") return null;
    return value as { category: ContentCategory; subtype: string; title: string; key: string; projectId: string };
  } catch { return null; }
}

export const aiWorkflows = ["preparation", "section", "planning", "writing", "entity", "records", "materials", "review"] as const;
export type AiWorkflow = typeof aiWorkflows[number];
export type AiWorkspaceTarget = {
  workflow: AiWorkflow;
  projectId: string;
  targetId?: string;
  item?: string;
  tab?: string;
  materialKind?: "SUMMARY" | "CARD";
  action?: "import" | "new";
  returnTo?: string;
};
export function aiWorkspaceHref(target: AiWorkspaceTarget) {
  const search = new URLSearchParams({ work: target.workflow, targetProject: target.projectId });
  if (target.targetId) {
    const key = target.workflow === "planning" || target.workflow === "writing" ? "planNode"
      : target.workflow === "entity" ? "entity" : target.workflow === "materials"
        ? target.materialKind === "CARD" ? "card" : "summary" : "objectId";
    search.set(key, target.targetId);
  }
  if (target.item) search.set("item", target.item);
  if (target.tab) search.set("tab", target.tab);
  if (target.workflow === "writing" && target.tab === "plan") search.set("assistant", "plan");
  if (target.workflow === "writing" && target.tab === "review") search.set("assistant", "review");
  if (target.materialKind) search.set("materialKind", target.materialKind);
  if (target.action) search.set("action", target.action);
  const returnTo = sourceReturnTo(target.returnTo ?? null);
  if (returnTo) search.set("returnTo", returnTo);
  return `/discussion?${search}`;
}

export function aiWorkspaceReturnHref(search: URLSearchParams) {
  const explicit = sourceReturnTo(search.get("returnTo"));
  if (explicit) return explicit;
  const work = search.get("work");
  const path = work === "entity" ? "/knowledge" : work === "records" ? "/knowledge/records"
    : work === "materials" ? "/knowledge/materials" : work === "writing" && search.get("tab") !== "plan" ? "/writing"
      : work === "review" ? "/review" : "/planning";
  const params = new URLSearchParams();
  for (const key of ["targetProject", "planNode", "entity", "summary", "card", "materialKind", "objectId", "item"]) {
    const value = search.get(key);
    if (value) params.set(key, value);
  }
  if (path === "/planning") params.set("mode", work === "preparation" || work === "section" ? "prepare" : "structure");
  if (work === "section" && search.get("item")) {
    params.delete("item");
    params.set("note", search.get("item")!);
  }
  if (work === "records" && search.get("tab")) params.set("tab", search.get("tab")!);
  return `${path}${params.size ? `?${params}` : ""}`;
}
