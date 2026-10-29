import { BookOpenText, FilePlus2, FolderOpen, PenLine } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage, getCurrentProject, listRecentProjects, listPlanNodes } from "../lib/tauri-client";
import { useProjectActions } from "../shell/project-actions-provider";
import { lastWritingChapterKey, resolveDefaultWritingChapter } from "./project-workspace-utils";
import { ChapterCreateDialog } from "./chapter-create-dialog";

function lastOpenedLabel(timestamp: string) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return "最近打开";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000));
}

export function EmptyProjectView() {
  const navigate = useNavigate();
  const actions = useProjectActions();
  const [createOpen, setCreateOpen] = useState(false);
  const recentProjects = useQuery({ queryKey: ["recent-projects"], queryFn: listRecentProjects });
  const currentProject = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const planNodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes, enabled: Boolean(currentProject.data) });
  let rememberedId = "";
  try {
    if (currentProject.data) rememberedId = window.localStorage.getItem(lastWritingChapterKey(currentProject.data.projectId)) ?? "";
  } catch { /* Position memory is optional. */ }
  const firstChapter = resolveDefaultWritingChapter(
    (planNodes.data ?? []).filter((node) => node.kind === "CHAPTER" && !node.archived), "", rememberedId,
  );
  return <section className="empty-project-view project-manager">
    <div className="workspace-heading project-manager-heading"><h1>作品管理</h1>
      <div className="project-actions" aria-label="作品操作">
        {firstChapter ? <Link to="/writing" hash={firstChapter.id} className="primary-action"><BookOpenText size={15} />继续写作</Link>
          : currentProject.data ? <Link to="/planning" search={{ mode: "prepare" }} className="primary-action"><PenLine size={15} />开始筹备</Link> : null}
        {currentProject.data ? <button type="button" className="secondary-action" disabled={Boolean(actions.busy) || planNodes.isPending || planNodes.isError}
          onClick={() => setCreateOpen(true)}><FilePlus2 size={15} />新建章节</button> : null}
        <button className={currentProject.data ? "secondary-action" : "primary-action"} type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.create()}>
          <FilePlus2 size={17} />{actions.busy === "create" ? "创建中…" : "新建作品"}</button>
        <button className="secondary-action" type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.open()}>
          <FolderOpen size={17} />{actions.busy === "open" ? "打开中…" : "打开作品"}</button>
      </div>
    </div>
    {planNodes.isError ? <p className="project-error" role="alert">无法读取章节：{errorMessage(planNodes.error)}
      <button type="button" onClick={() => void planNodes.refetch()}>重试</button></p> : null}
    {createOpen && currentProject.data ? <ChapterCreateDialog projectId={currentProject.data.projectId} nodes={planNodes.data ?? []}
      onClose={() => setCreateOpen(false)} onCreated={(node) => void navigate({ to: "/writing", hash: node.id })} /> : null}
    <div className="recent-projects"><div className="section-heading"><h2>最近作品</h2><span>{recentProjects.data?.length ?? 0} 部</span></div>
      {recentProjects.isError ? <div className="project-error" role="alert">无法读取最近作品：{errorMessage(recentProjects.error)}
        <button type="button" className="secondary-action" onClick={() => void recentProjects.refetch()}>重试</button></div> : null}
      {recentProjects.data?.length ? <div className="recent-project-list">{recentProjects.data.map((project) =>
        <button key={project.root} type="button" className="recent-project-row" disabled={Boolean(actions.busy)} onClick={() => void actions.openRecent(project)}>
          <FolderOpen size={18} strokeWidth={1.6} /><span className="recent-project-copy"><strong>{project.name}</strong><span title={project.root}>{project.root}</span></span>
          <time dateTime={project.lastOpenedAt}>{lastOpenedLabel(project.lastOpenedAt)}</time>
        </button>)}</div> : <div className="empty-list"><div className="empty-list-icon" aria-hidden="true"><FolderOpen size={21} strokeWidth={1.5} /></div>
        <p>{recentProjects.isPending ? "正在读取最近作品…" : recentProjects.isError ? "最近作品暂不可用" : "暂无最近作品"}</p></div>}
    </div>
  </section>;
}
