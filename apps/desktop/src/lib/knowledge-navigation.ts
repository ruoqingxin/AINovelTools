import { manuscriptSourceHref, sourceReturnTo } from "./manuscript-source";
import type { PlanNode, SummaryMaterial } from "./tauri-client";

export function materialHref(kind: "SUMMARY" | "CARD", id: string, projectId: string, returnTo?: string) {
  const params = new URLSearchParams({ [kind === "SUMMARY" ? "summary" : "card"]: id, targetProject: projectId });
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/knowledge/materials?${params}`;
}

export function parseMaterialTarget(search: string) {
  const params = new URLSearchParams(search);
  if (!params.has("summary") && !params.has("card")) return null;
  const kind: "SUMMARY" | "CARD" | null = params.has("summary") === params.has("card") ? null : params.has("summary") ? "SUMMARY" : "CARD";
  return {
    kind, id: params.get(kind === "SUMMARY" ? "summary" : "card") ?? "",
    projectId: params.get("targetProject") ?? "",
  };
}

export function planNodeHref(id: string, projectId: string, returnTo?: string, writing = false) {
  const params = new URLSearchParams({ planNode: id, targetProject: projectId });
  if (writing) params.set("assistant", "plan");
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `${writing ? "/writing" : "/planning"}?${params}#${encodeURIComponent(id)}`;
}

export function resolvePlanNodeTarget(id: string, projectId: string | null, currentProjectId: string | undefined, nodes: PlanNode[], writing = false) {
  if (!id || !projectId || projectId !== currentProjectId) return null;
  return nodes.find((node) => node.id === id && !node.archived && (!writing || node.kind === "CHAPTER")) ?? null;
}

export function summaryManuscriptHref(summary: SummaryMaterial, returnTo: string) {
  // Only generated chapter memory has a defined manuscript-source contract.
  if (summary.kind !== "CHAPTER" || summary.generationMode !== "EXTRACTIVE_AUTO" || !summary.sourceId) return null;
  const revisionId = summary.sourceVersion?.match(/^manuscript:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  return revisionId ? manuscriptSourceHref({
    projectId: summary.projectId, chapterId: summary.sourceId, revisionId,
  }, returnTo) : null;
}
