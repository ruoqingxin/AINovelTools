import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, BookOpenText, Files, ListTree, MessageSquareText, NotebookTabs, NotebookPen, ShieldCheck, UsersRound } from "lucide-react";
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
import { PreparationNotesNav } from "./preparation-notes-nav";
import { useActiveNavigation } from "./use-active-navigation";
import { BookPreparationView } from "./book-preparation-view";

const destinations: Record<AiWorkflow, string> = {
  preparation: "筹备", section: "筹备", planning: "大纲", writing: "正文",
  entity: "设定", records: "剧情记录", materials: "辅助参考", review: "待办核对",
};

export function UnifiedAiWorkspace() {
  const router = useRouter({ warn: false });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const search = new URLSearchParams(router?.state.location.searchStr ?? window.location.search);
  const work = search.get("work");
  const workflow = aiWorkflows.includes(work as AiWorkflow) ? work as AiWorkflow : null;
  const chapterPlan = workflow === "writing" && search.get("tab") === "plan";
  const projectId = project.data?.projectId;
  const invalid = Boolean(work && (!workflow || !search.get("targetProject") || search.get("targetProject") !== projectId));
  const destination = chapterPlan ? "大纲 · 章节细纲" : workflow ? destinations[workflow] : null;
  const categoryNav = useActiveNavigation(`${projectId}:${workflow}:${chapterPlan}`);
  const category = invalid ? null : !work ? "discussion" : workflow === "section" ? "preparation" : chapterPlan ? "planning" : workflow;
  const currentHref = router?.state.location.href ?? `/discussion${window.location.search}${window.location.hash}`;
  const categories = projectId ? [
    { id: "discussion", label: "自由讨论", icon: MessageSquareText, href: "/discussion" },
    { id: "preparation", label: "筹备", icon: NotebookPen, href: aiWorkspaceHref({ projectId, workflow: "preparation" }) },
    { id: "entity", label: "设定", icon: UsersRound, href: aiWorkspaceHref({ projectId, workflow: "entity" }) },
    { id: "planning", label: "大纲", icon: ListTree, href: aiWorkspaceHref({ projectId, workflow: "planning" }) },
    { id: "writing", label: "正文", icon: BookOpenText, href: aiWorkspaceHref({ projectId, workflow: "writing" }) },
    { id: "records", label: "剧情记录", icon: NotebookTabs, href: aiWorkspaceHref({ projectId, workflow: "records" }) },
    { id: "materials", label: "辅助参考", icon: Files, href: aiWorkspaceHref({ projectId, workflow: "materials" }) },
    { id: "review", label: "待办核对", icon: ShieldCheck, href: aiWorkspaceHref({ projectId, workflow: "review" }) },
  ] : [];
  return <AiWorkspaceContext.Provider value>
    <section className="unified-ai-workspace" data-workflow={!work ? "discussion" : workflow ?? "invalid"}>
      <header className="ai-workspace-heading"><h1>共创</h1>
      {projectId && <nav ref={categoryNav} className="ai-category-nav" aria-label="AI 内容分类">
        {categories.map(({ id, label, icon: Icon, href }) => <WorkspaceLink key={id}
          href={category === id ? currentHref : href} aria-current={category === id ? "page" : undefined}>
          <Icon size={15} />{label}
        </WorkspaceLink>)}
      </nav>}
        {destination && !invalid && <WorkspaceLink href={aiWorkspaceReturnHref(search)} className="activity-return"><ArrowLeft size={14} />返回{sourceReturnTo(search.get("returnTo")) ? "来源" : destination}</WorkspaceLink>}
      </header>
      {project.isPending ? <p role="status">正在核对工作区项目…</p>
        : project.isError ? <p role="alert" className="project-error">{errorMessage(project.error)}</p>
          : invalid ? <p role="alert" className="project-error">工作区链接无效或不属于当前作品，未打开其他对象。</p>
            : !project.data ? <p role="status">请先打开作品。</p>
            : !workflow ? <CoauthorView />
              : <>
                {(workflow === "preparation" || workflow === "section") && <PreparationNotesNav
                  selectedId={workflow === "section" ? search.get("item") ?? "seed-tone" : search.has("item") ? undefined : "seed-tone"} />}
                {workflow === "preparation" && (search.has("item")
                  ? <CreationPreparationView embedded initialItem={search.get("item") ?? undefined} /> : <BookPreparationView />)}
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
