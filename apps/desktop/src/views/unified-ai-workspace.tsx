import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, Files, ListTree, MessageSquareText, NotebookTabs, UsersRound } from "lucide-react";
import { aiWorkflows, aiWorkspaceHref, type AiWorkflow } from "../lib/content-taxonomy";
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

const destinations: Record<AiWorkflow, { label: string; source: string; output: string }> = {
  preparation: { label: "创作准备", source: "/planning", output: "当前准备事项；混合笔记保留待归类" },
  section: { label: "创作准备", source: "/planning?mode=structure", output: "当前准备节点，不自动转为人物实体或剧情记录" },
  planning: { label: "大纲", source: "/planning?mode=structure", output: "指定的全书大纲、分卷规划或章节结构" },
  writing: { label: "正文", source: "/writing", output: "当前章节；提取结果按设定、事实与剧情记录分别核对" },
  entity: { label: "设定", source: "/knowledge", output: "人物、地点、阵营、物品或世界规则与概念" },
  records: { label: "剧情记录", source: "/knowledge/records", output: "关系、事件、人物认知或伏笔；保留证据要求" },
  materials: { label: "辅助参考", source: "/knowledge/materials", output: "摘要与记忆、风格规则或写作技巧" },
  review: { label: "待办核对", source: "/review", output: "对应对象的待核对结果" },
};

export function UnifiedAiWorkspace() {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const search = new URLSearchParams(window.location.search);
  const work = search.get("work");
  const workflow = aiWorkflows.includes(work as AiWorkflow) ? work as AiWorkflow : null;
  const chapterPlan = workflow === "writing" && search.get("tab") === "plan";
  const projectId = project.data?.projectId;
  const invalid = Boolean(work && (!workflow || !search.get("targetProject") || search.get("targetProject") !== projectId));
  const destination = chapterPlan
    ? { label: "大纲 · 章节细纲", source: "/planning?mode=structure", output: "章节细纲" }
    : workflow ? destinations[workflow] : null;
  return <AiWorkspaceContext.Provider value>
    <section className="unified-ai-workspace">
      <header className="ai-workspace-heading"><h1>AI 工作区</h1>
        {destination && <a href={destination.source} className="activity-return"><ArrowLeft size={14} />返回{destination.label}</a>}
      </header>
      {projectId && <nav className="ai-category-nav" aria-label="AI 内容分类">
        <a href="/discussion" aria-current={!work ? "page" : undefined}><MessageSquareText size={15} />自由构思</a>
        <a href={aiWorkspaceHref({ projectId, workflow: "entity" })} aria-current={workflow === "entity" ? "page" : undefined}><UsersRound size={15} />设定</a>
        <a href={aiWorkspaceHref({ projectId, workflow: "planning" })} aria-current={workflow === "planning" || workflow === "preparation" || workflow === "section" || chapterPlan ? "page" : undefined}><ListTree size={15} />大纲与准备</a>
        <a href={aiWorkspaceHref({ projectId, workflow: "writing" })} aria-current={workflow === "writing" && !chapterPlan ? "page" : undefined}><BookOpenText size={15} />正文</a>
        <a href={aiWorkspaceHref({ projectId, workflow: "records" })} aria-current={workflow === "records" ? "page" : undefined}><NotebookTabs size={15} />剧情记录</a>
        <a href={aiWorkspaceHref({ projectId, workflow: "materials" })} aria-current={workflow === "materials" ? "page" : undefined}><Files size={15} />辅助参考</a>
      </nav>}
      {project.isPending ? <p role="status">正在核对工作区项目…</p>
        : project.isError ? <p role="alert" className="project-error">{errorMessage(project.error)}</p>
          : invalid ? <p role="alert" className="project-error">工作区链接无效或不属于当前作品，未打开其他对象。</p>
            : !project.data ? <p role="status">请先打开作品。</p>
            : !workflow ? <CoauthorView />
              : <>
                <div className="ai-workspace-identity" aria-label="工作区任务">
                  <h2>{destination!.label}</h2>
                  <dl><dt>内容归属</dt><dd>{destination!.output}</dd><dt>作品</dt><dd>{project.data?.name ?? projectId}</dd></dl>
                </div>
                {workflow === "preparation" && <CreationPreparationView initialItem={search.get("item") ?? undefined} />}
                {workflow === "section" && <StoryPlanningWorkbench selectedSectionId={search.get("item") ?? undefined} />}
                {workflow === "planning" && <ProjectWorkspaceView />}
                {workflow === "writing" && <ProjectWorkspaceView mode="writing" />}
                {workflow === "entity" && <StoryBibleView />}
                {workflow === "records" && <KnowledgeRecordsView />}
                {workflow === "materials" && <MaterialsView />}
                {workflow === "review" && <ReviewCenterView />}
              </>}
    </section>
  </AiWorkspaceContext.Provider>;
}
