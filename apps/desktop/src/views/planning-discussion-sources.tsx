import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { MessageSquareText, RefreshCw } from "lucide-react";
import { useState } from "react";
import { discussionSourceHref, planningTargetHref } from "../lib/discussion-source";
import { errorMessage, getCurrentProject, listPlanningDiscussionSources } from "../lib/tauri-client";
import "./discussion-source.css";

const PAGE_SIZE = 20;

export function PlanningDiscussionSources({ sectionId, active = true, returnTo }: { sectionId: string; active?: boolean; returnTo?: string }) {
  const [open, setOpen] = useState(false);
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, enabled: active && open, staleTime: 30_000 });
  const sources = useInfiniteQuery({
    queryKey: ["planning-discussion-sources", project.data?.projectId, sectionId],
    queryFn: ({ pageParam }) => listPlanningDiscussionSources(sectionId, project.data!.projectId, PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, offset) => last.length === PAGE_SIZE ? offset + PAGE_SIZE : undefined,
    enabled: active && open && Boolean(project.data) && Boolean(sectionId), retry: false,
  });
  const failed = project.isError || sources.isError;
  return <details className="planning-discussion-sources" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><MessageSquareText size={14} />讨论流转记录</summary>
    {open ? <div>
      {failed ? <p className="project-error" role="alert">{errorMessage(project.error ?? sources.error)}
        <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : sources.refetch())}><RefreshCw size={14} />重试</button></p>
        : !project.isPending && !project.data ? <p>未打开来源项目。</p>
        : sources.isPending ? <p role="status">正在读取流转记录…</p> : null}
      {!failed ? sources.data?.pages.flat().map(({ candidate, sessionTitle, projectId }) => <article key={candidate.id}>
        <div><strong>{sessionTitle}</strong><span>曾送入待定区</span></div>
        <p>{Array.from(candidate.content).slice(0, 240).join("")}{Array.from(candidate.content).length > 240 ? "…" : ""}</p>
        <a href={discussionSourceHref({ candidateId: candidate.id, sessionId: candidate.sessionId, sectionId, projectId },
          returnTo ?? planningTargetHref(sectionId, projectId))}><MessageSquareText size={14} />查看讨论来源</a>
      </article>) : null}
      {sources.isSuccess && !sources.data.pages.some((page) => page.length) ? <p>暂无讨论流转记录。</p> : null}
      {sources.hasNextPage ? <button type="button" className="secondary-action" onClick={() => void sources.fetchNextPage()} disabled={sources.isFetching}>{sources.isFetchingNextPage ? "正在加载…" : "加载更多"}</button> : null}
    </div> : null}
  </details>;
}
