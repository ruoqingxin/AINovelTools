import { BookOpen, ListTree, NotebookPen } from "lucide-react";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { useInAiWorkspace } from "./content-identity";
import { preparationStatus, preparationStatusLabels } from "./creation-preparation";
import { WorkspaceLink } from "./workspace-link";
import { aiWorkspaceHref } from "../lib/content-taxonomy";
import { WorkspaceEmptyState } from "./workspace-empty-state";

type PlanningDashboardProps = {
  chapterNodes: PlanNode[];
  isChapterMode: boolean;
  onOpenFirstChapter: () => void;
  onOpenDirection?: () => void;
  onOpenStructure?: () => void;
  structureTask?: boolean;
  outlineId?: string;
  projectId?: string;
  nodes?: PlanNode[];
  sections?: PlanningSection[];
  loadState?: "loading" | "error" | "ready";
  awaitingStructure?: boolean;
  structureTargetId?: string;
};

export function PlanningDashboard(props: PlanningDashboardProps) {
  const aiWorkspace = useInAiWorkspace();
  if (!props.isChapterMode) {
    const nodes = (props.nodes ?? []).filter((node) => !node.archived);
    const outline = nodes.find((node) => node.kind === "OUTLINE" && (!props.outlineId || node.id === props.outlineId));
    const manager = nodes.find((node) => node.kind === "VOLUME_MANAGER");
    const section = props.sections?.find((entry) => entry.id === `plan-node:${outline?.id}`);
    const hasContent = Boolean(section?.content.trim());
    const ready = !props.loadState || props.loadState === "ready";
    const writeLabel = hasContent ? "修改全书大纲" : "编写全书大纲";
    const counts = [
      `${nodes.filter((node) => node.kind === "VOLUME").length} 卷`,
      `${nodes.filter((node) => node.kind === "CHAPTER").length} 章`,
      `${nodes.filter((node) => node.kind === "SCENE").length} 场景`,
    ].join(" · ");
    if (props.structureTask) return <main className="outline-reader" aria-label="分卷与章节">
      <header className="outline-reader-heading"><div><span className="outline-reader-type">{counts}</span><h2>分卷与章节</h2></div></header>
      <section className="outline-reader-empty">
        <WorkspaceEmptyState icon={ListTree} title="尚未建立分卷规划">
        {aiWorkspace && <button type="button" className="primary-action" onClick={props.onOpenStructure}><ListTree size={15} />开始规划分卷与章节</button>}
        </WorkspaceEmptyState>
      </section>
    </main>;
    return <main className="outline-reader" aria-label="全书大纲">
      <header className="outline-reader-heading">
        <div><span className="outline-reader-type">{counts}</span><h2>全书大纲</h2></div>
      </header>
      <div className="outline-reader-toolbar">
        <span className="outline-reader-type">大纲 · 全书</span>
        {hasContent && ready && <span className="outline-reader-state">{preparationStatusLabels[preparationStatus(section, props.sections)]}</span>}
        <div className="outline-reader-actions">
        {hasContent && ready && (aiWorkspace
          ? <button type="button" className="secondary-action" onClick={props.onOpenDirection}><NotebookPen size={15} />{writeLabel}</button>
          : props.projectId ? <WorkspaceLink className="secondary-action" href={aiWorkspaceHref({ projectId: props.projectId,
            workflow: "planning", targetId: outline?.id })}><NotebookPen size={15} />{writeLabel}</WorkspaceLink> : null)}
        {aiWorkspace ? <button type="button" className="secondary-action" onClick={props.onOpenStructure}><ListTree size={15} />规划分卷与章节</button>
          : props.projectId ? <WorkspaceLink className="secondary-action" href={aiWorkspaceHref({ projectId: props.projectId,
            workflow: "planning", targetId: manager?.id, item: manager ? undefined : "structure" })}><ListTree size={15} />规划分卷与章节</WorkspaceLink> : null}
        </div>
      </div>
      {!ready ? <p role="status" className="outline-reader-message">{props.loadState === "loading" ? "正在读取全书大纲…" : "暂时无法读取全书大纲"}</p>
        : hasContent ? <p className="outline-reader-text">{section!.content}</p> : <section className="outline-reader-empty" aria-label="尚无全书大纲">
        <WorkspaceEmptyState icon={NotebookPen} title="尚无正式全书大纲">
        {section?.pendingContent.trim() ? <span className="outline-reader-state">有待确认工作稿</span> : null}
        {aiWorkspace ? <button type="button" className="primary-action" onClick={props.onOpenDirection}><NotebookPen size={15} />{writeLabel}</button>
          : props.projectId ? <WorkspaceLink className="primary-action" href={aiWorkspaceHref({ projectId: props.projectId,
            workflow: "planning", targetId: outline?.id })}><NotebookPen size={15} />{writeLabel}</WorkspaceLink> : null}
        </WorkspaceEmptyState>
      </section>}
      {hasContent && ready && section?.pendingContent.trim() ? <p className="outline-reader-pending" role="status">有待确认工作稿</p> : null}
    </main>;
  }
  return <main className="workspace-empty" aria-label="正文工作区">
    <WorkspaceEmptyState icon={BookOpen} headingLevel={2}
      title={props.chapterNodes.length ? "选择章节" : props.awaitingStructure ? "尚未规划分卷与章节" : "故事尚未开始"}>
    {!props.chapterNodes.length && props.projectId && props.awaitingStructure ? <WorkspaceLink
      href={aiWorkspaceHref({ projectId: props.projectId, workflow: "planning", targetId: props.structureTargetId })}
      className="primary-action"><ListTree size={15} />规划分卷与章节</WorkspaceLink>
      : !props.chapterNodes.length && props.projectId ? <WorkspaceLink
      href={aiWorkspaceHref({ projectId: props.projectId, workflow: "preparation" })}
      className="primary-action"><NotebookPen size={15} />开始筹备</WorkspaceLink> : null}
    {props.chapterNodes.length ? <button type="button" className="primary-action" onClick={props.onOpenFirstChapter}>
      <BookOpen size={15} />打开章节</button> : null}
    </WorkspaceEmptyState>
  </main>;
}
