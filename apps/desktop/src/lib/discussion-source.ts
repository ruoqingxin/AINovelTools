import { useQuery } from "@tanstack/react-query";
import { sourceReturnTo } from "./manuscript-source";
import { getCurrentProject, getDiscussionSource, type DiscussionSourceRequest, type PlanNode } from "./tauri-client";

export function parseDiscussionSource(search: string): DiscussionSourceRequest | null {
  const params = new URLSearchParams(search);
  if (!["sourceCandidate", "sourceSession", "sourceSection", "sourceProject"].some((field) => params.has(field))) return null;
  return {
    candidateId: params.get("sourceCandidate") ?? "",
    ...(params.get("sourceSession") ? { sessionId: params.get("sourceSession")! } : {}),
    ...(params.get("sourceSection") ? { sectionId: params.get("sourceSection")! } : {}),
    ...(params.get("sourceProject") ? { projectId: params.get("sourceProject")! } : {}),
  };
}

export function discussionSourceHref(request: DiscussionSourceRequest, returnTo?: string) {
  const params = new URLSearchParams({ sourceCandidate: request.candidateId });
  for (const [field, value] of Object.entries({
    sourceSession: request.sessionId, sourceSection: request.sectionId, sourceProject: request.projectId,
  })) { if (value) params.set(field, value); }
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/discussion?${params}`;
}

export function planningTargetHref(sectionId: string, projectId?: string, nodeKind?: string | null) {
  const nodeId = sectionId.startsWith("plan-node:") ? sectionId.slice("plan-node:".length) : sectionId;
  const params = new URLSearchParams({ discussionTarget: sectionId });
  if (projectId) params.set("targetProject", projectId);
  if (nodeKind === "CHAPTER") params.set("assistant", "plan");
  return `${nodeKind === "CHAPTER" ? "/writing" : "/planning"}?${params}#${encodeURIComponent(nodeId)}`;
}

export function resolveDiscussionPlanningTarget(sectionId: string, nodes: PlanNode[], settingIds: readonly string[], writing = false) {
  if (!writing && settingIds.includes(sectionId)) {
    const node = nodes.find((item) => item.kind === "WORK_DESIGN" && !item.archived);
    return node ? { node, sectionId } : null;
  }
  if (!sectionId.startsWith("plan-node:")) return null;
  const node = nodes.find((item) => !item.archived && `plan-node:${item.id}` === sectionId
    && (writing ? item.kind === "CHAPTER" : ["OUTLINE", "VOLUME", "SCENE"].includes(item.kind)));
  return node ? { node, sectionId: null } : null;
}

export function useDiscussionSource(request: DiscussionSourceRequest) {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, staleTime: 30_000 });
  const source = useQuery({
    queryKey: ["discussion-source", project.data?.projectId, request],
    queryFn: () => {
      if (!request.candidateId) throw new Error("未指定来源候选");
      return getDiscussionSource({ ...request, projectId: request.projectId ?? project.data!.projectId });
    },
    enabled: Boolean(project.data), retry: false,
  });
  return { project, source };
}
