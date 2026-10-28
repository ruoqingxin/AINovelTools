import { sourceReturnTo } from "./manuscript-source";

export { entityTypeLabels } from "./content-taxonomy";

export function entityHref(entityId: string, projectId: string, returnTo?: string) {
  const params = new URLSearchParams({ entity: entityId, targetProject: projectId });
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/knowledge?${params}`;
}

export function entityChapterHref(chapterId: string, projectId: string, returnTo?: string) {
  const params = new URLSearchParams({ referenceChapter: chapterId, targetProject: projectId, assistant: "plan", tab: "plan", work: "writing" });
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/discussion?${params}#${encodeURIComponent(chapterId)}`;
}
