import { BookOpenText, ClipboardList, SquarePen } from "lucide-react";
import type { PlanNode } from "../lib/tauri-client";
import { aiWorkspaceHref } from "../lib/content-taxonomy";
import { ContentTypeLabel } from "./content-identity";
import { WorkspaceLink } from "./workspace-link";
import "./chapter-creation-workspace.css";
import "./volume-reading-workspace.css";

export function VolumeReadingWorkspace({ volume, chapters, projectId, content, pending = false, loadState = "ready", returnTo, onReadChapter }: {
  volume: PlanNode;
  chapters: PlanNode[];
  projectId: string;
  content: string;
  pending?: boolean;
  loadState?: "loading" | "error" | "ready";
  returnTo?: string;
  onReadChapter?: (chapter: PlanNode) => void;
}) {
  const hasContent = Boolean(content.trim());
  const editHref = aiWorkspaceHref({ workflow: "planning", projectId, targetId: volume.id, returnTo });
  const firstChapter = chapters[0];
  return <section className="chapter-reading-workspace volume-reading-workspace" aria-label="分卷概览">
    <header className="volume-reading-heading">
      <span>分卷 · {chapters.length} 章</span>
      <h2>{volume.title}</h2>
    </header>
    <div className="chapter-reading-toolbar">
      <ContentTypeLabel identity={{ category: "OUTLINE", subtype: "分卷规划" }} />
      <div className="chapter-reading-actions">
        {hasContent && loadState === "ready" ? <WorkspaceLink className="reader-plan-action" href={editHref}>
          <SquarePen size={15} />编辑分卷规划
        </WorkspaceLink> : null}
        {firstChapter ? onReadChapter ? <button type="button" className="secondary-action" onClick={() => onReadChapter(firstChapter)}>
          <BookOpenText size={15} />阅读本卷
        </button> : <WorkspaceLink className="secondary-action"
          href={`/writing?targetProject=${encodeURIComponent(projectId)}&planNode=${encodeURIComponent(firstChapter.id)}`}>
          <BookOpenText size={15} />阅读本卷
        </WorkspaceLink> : null}
      </div>
    </div>
    <div className="chapter-reading-content">
      {loadState !== "ready" ? <p role="status" className="chapter-reading-message">
        {loadState === "loading" ? "正在读取分卷规划…" : "暂时无法读取分卷规划"}
      </p> : hasContent ? <p className="volume-reading-plan">{content}</p> : <div className="chapter-reading-empty">
        <ClipboardList size={36} strokeWidth={1.25} aria-hidden="true" />
        <h3>暂无分卷规划</h3>
        {pending && <p role="status">有待核对工作稿</p>}
        <WorkspaceLink className="primary-action reader-start-action" href={editHref}>
          <SquarePen size={16} />{pending ? "核对分卷规划" : "编写分卷规划"}
        </WorkspaceLink>
      </div>}
    </div>
    {loadState === "ready" && hasContent && pending ? <p role="status" className="chapter-reading-draft-status">有待核对工作稿</p> : null}
  </section>;
}
