import { sourceReturnTo } from "./manuscript-source";

export const entityTypeLabels = { CHARACTER: "人物", LOCATION: "地点", FACTION: "阵营", ITEM: "物品", CONCEPT: "概念" } as const;

export function entityHref(entityId: string, projectId: string, returnTo?: string) {
  const params = new URLSearchParams({ entity: entityId, targetProject: projectId });
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/knowledge?${params}`;
}

export function entityChapterHref(chapterId: string, projectId: string, returnTo?: string) {
  const params = new URLSearchParams({ referenceChapter: chapterId, targetProject: projectId, assistant: "plan" });
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/writing?${params}#${encodeURIComponent(chapterId)}`;
}
