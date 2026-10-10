import { useQuery } from "@tanstack/react-query";
import { getCurrentProject, getManuscriptSource, type ManuscriptSourceRequest } from "./tauri-client";

const sourceFields = {
  sourceProject: "projectId", sourceRevision: "revisionId", sourceEvidence: "evidenceAnchorId",
  sourceChapter: "chapterId", sourceBlock: "blockId",
} as const;

export function parseManuscriptSource(search: string): ManuscriptSourceRequest | null {
  const params = new URLSearchParams(search);
  if (!Object.keys(sourceFields).some((key) => params.has(key))) return null;
  return Object.fromEntries(Object.entries(sourceFields)
    .flatMap(([key, field]) => params.get(key) ? [[field, params.get(key)!]] : []));
}

export function sourceReturnTo(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || ![
      "/search", "/writing", "/chapters", "/review", "/knowledge/review", "/knowledge/records", "/knowledge", "/knowledge/materials", "/discussion", "/planning",
    ].includes(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function manuscriptSourceHref(request: ManuscriptSourceRequest, returnTo?: string) {
  const params = new URLSearchParams();
  for (const [key, field] of Object.entries(sourceFields)) {
    if (request[field]) params.set(key, request[field]!);
  }
  const safeReturn = sourceReturnTo(returnTo ?? null);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/writing?${params.toString()}`;
}

export function useManuscriptSource(request: ManuscriptSourceRequest, active = true) {
  const project = useQuery({
    queryKey: ["current-project"], queryFn: getCurrentProject, staleTime: 30_000, enabled: active,
  });
  const source = useQuery({
    queryKey: ["manuscript-source", project.data?.projectId, request],
    queryFn: () => getManuscriptSource({ ...request, projectId: request.projectId ?? project.data!.projectId }),
    enabled: active && Boolean(project.data), retry: false,
  });
  return { project, source };
}
