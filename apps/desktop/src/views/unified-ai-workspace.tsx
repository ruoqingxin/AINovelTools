import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, Files, ListTree, MessageSquareText, NotebookTabs, NotebookPen, UsersRound } from "lucide-react";
import { aiWorkflows, aiWorkspaceHref, aiWorkspaceReturnHref, type AiWorkflow } from "../lib/content-taxonomy";
import { errorMessage, getCurrentProject } from "../lib/tauri-client";
import { AiWorkspaceContext } from "./content-identity";
import { CoauthorView } from "./coauthor-view";
import { CreationPreparationView } from "./creation-preparation-view";
import { StoryPlanningWorkbench } from "./story-planning-workbench";
import { ProjectWorkspaceView } from "./project-workspace-view";
import { StoryBibleView } from "./story-bible-view";
import { MaterialsView } from "./materials-view";
import { KnowledgeRecordsView } from "./knowledge-records-view";
import { ReviewCenterView } from "./review-center-view";
import { WorkspaceLink } from "./workspace-link";
import { sourceReturnTo } from "../lib/manuscript-source";

const destinations: Record<AiWorkflow, string> = {
  preparation: "创作准备", section: "创作准备", planning: "大纲", writing: "正文",
  entity: "设定", records: "剧情记录", materials: "辅助参考", review: "待办核对",
};

export function UnifiedAiWorkspace() {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const search = new URLSearchParams(window.location.search);
  const work = search.get("work");
  const workflow = aiWorkflows.includes(work as AiWorkflow) ? work as AiWorkflow : null;
  const chapterPlan = workflow === "writing" && search.get("tab") === "plan";
  const projectId = project.data?.projectId;
  const invalid = Boolean(work && (!workflow || !search.get("targetProject") || search.get("targetProject") !== projectId));
  const destination = chapterPlan ? "大纲 · 章节细纲" : workflow ? destinations[workflow] : null;
  return <AiWorkspaceContext.Provider value>
    <section className="unified-ai-workspace">
      <header className="ai-workspace-heading"><h1>AI 工作区</h1>
        {destination && !invalid && <WorkspaceLink href={aiWorkspaceReturnHref(search)} className="activity-return"><ArrowLeft size={14} />返回{sourceReturnTo(search.get("returnTo")) ? "来源" : destination}</WorkspaceLink>}
        {projectId && <WorkspaceLink className="ai-preparation-link" href={aiWorkspaceHref({ projectId, workflow: "preparation" })}
          aria-current={workflow === "preparation" || workflow === "section" ? "page" : undefined}><NotebookPen size={15} />创作准备</WorkspaceLink>}
      </header>
      {projectId && <nav className="ai-category-nav" aria-label="AI 内容分类">
        <WorkspaceLink href="/discussion" aria-current={!work ? "page" : undefined}><MessageSquareText size={15} />自由构思</WorkspaceLink>
        <WorkspaceLink href={aiWorkspaceHref({ projectId, workflow: "entity" })} aria-current={workflow === "entity" ? "page" : undefined}><UsersRound size={15} />设定</WorkspaceLink>
        <WorkspaceLink href={aiWorkspaceHref({ projectId, workflow: "planning" })} aria-current={workflow === "planning" || chapterPlan ? "page" : undefined}><ListTree size={15} />大纲</WorkspaceLink>
        <WorkspaceLink href={aiWorkspaceHref({ projectId, workflow: "writing" })} aria-current={workflow === "writing" && !chapterPlan ? "page" : undefined}><BookOpenText size={15} />正文</WorkspaceLink>
        <WorkspaceLink href={aiWorkspaceHref({ projectId, workflow: "records" })} aria-current={workflow === "records" ? "page" : undefined}><NotebookTabs size={15} />剧情记录</WorkspaceLink>
        <WorkspaceLink href={aiWorkspaceHref({ projectId, workflow: "materials" })} aria-current={workflow === "materials" ? "page" : undefined}><Files size={15} />辅助参考</WorkspaceLink>
      </nav>}
      {project.isPending ? <p role="status">正在核对工作区项目…</p>
        : project.isError ? <p role="alert" className="project-error">{errorMessage(project.error)}</p>
          : invalid ? <p role="alert" className="project-error">工作区链接无效或不属于当前作品，未打开其他对象。</p>
            : !project.data ? <p role="status">请先打开作品。</p>
            : !workflow ? <CoauthorView />
              : <>
                {workflow === "preparation" && <CreationPreparationView embedded initialItem={search.get("item") ?? undefined} />}
                {workflow === "section" && <StoryPlanningWorkbench selectedSectionId={search.get("item") ?? undefined} />}
                {workflow === "planning" && <ProjectWorkspaceView />}
                {workflow === "writing" && <ProjectWorkspaceView mode="writing" chapterPlanTask={chapterPlan} />}
                {workflow === "entity" && <StoryBibleView />}
                {workflow === "records" && <KnowledgeRecordsView />}
                {workflow === "materials" && <MaterialsView />}
                {workflow === "review" && <ReviewCenterView />}
              </>}
    </section>
  </AiWorkspaceContext.Provider>;
}
