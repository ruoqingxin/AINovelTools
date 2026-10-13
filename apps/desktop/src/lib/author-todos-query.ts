import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listAuthorTodos, type AuthorTodo, type AuthorTodoKind } from "./tauri-client";

export function useAuthorTodos({ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || !poll) return;
    // The shell refreshes the queue when canonical workspaces receive updated records.
    const sources = new Set(["knowledge-candidates", "chapter-extractions", "discussion-design-proposals", "ai-proposals", "recovery-logs", "recovery-all"]);
    return client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success"
        && sources.has(String(event.query.queryKey[0]))) {
        void client.invalidateQueries({ queryKey: ["author-todos"] });
      }
    });
  }, [client, enabled, poll]);
  return useQuery({
    queryKey: ["author-todos"],
    queryFn: listAuthorTodos,
    enabled,
    refetchInterval: poll ? 15_000 : false,
  });
}

export const todoLabels: Record<AuthorTodoKind, { title: string; status: string; action: string }> = {
  FACT_REVIEW: { title: "事实审核", status: "待批准", action: "审核事实" },
  FACT_FINALIZE: { title: "事实定稿", status: "已批准 · 待定稿", action: "核对并定稿" },
  EXTRACTION: { title: "知识候选", status: "待确认", action: "处理知识候选" },
  EXTRACTION_DEFERRED: { title: "延后知识候选", status: "已延期 · 待决定", action: "处理知识候选" },
  DISCUSSION_DESIGN: { title: "构思设定", status: "待确认", action: "确认设定" },
  RECOVERY: { title: "异常草稿", status: "待恢复或放弃", action: "处理异常草稿" },
  WRITING_PROPOSAL: { title: "正文候选", status: "待采用或拒绝", action: "打开写作助手" },
};

export function todoHref(item: AuthorTodo, projectId: string) {
  const params = new URLSearchParams({ targetProject: projectId, returnTo: "/review" });
  if (item.kind === "DISCUSSION_DESIGN") {
    params.set("design", "results");
    params.set("targetSession", item.targetId);
    return `/discussion?${params}#${encodeURIComponent(item.targetId)}`;
  }
  params.set("referenceChapter", item.targetId);
  if (item.kind === "RECOVERY") params.set("tab", "versions");
  else if (item.kind === "WRITING_PROPOSAL") params.set("assistant", "ai");
  else {
    params.set("tab", "extraction");
    if (item.kind !== "EXTRACTION" && item.kind !== "EXTRACTION_DEFERRED") params.set("knowledge", "facts");
  }
  return `/writing?${params}#${encodeURIComponent(item.targetId)}`;
}
