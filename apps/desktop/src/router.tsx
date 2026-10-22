import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "./shell/app-shell";
import { EmptyProjectView } from "./views/empty-project-view";
import { useQuery } from "@tanstack/react-query";
import { getCurrentProject, listPlanningSections, listPlanNodes } from "./lib/tauri-client";
import { parseManuscriptSource } from "./lib/manuscript-source";
import { parseDiscussionSource } from "./lib/discussion-source";
import { buildPreparationStages, preparationProgress } from "./views/creation-preparation";
import { readPlanningReview } from "./views/planning-review";

const ProjectWorkspaceView = lazyRouteComponent(() => import("./views/project-workspace-view"), "ProjectWorkspaceView");
const StoryBibleView = lazyRouteComponent(() => import("./views/story-bible-view"), "StoryBibleView");
const MaterialsView = lazyRouteComponent(() => import("./views/materials-view"), "MaterialsView");
const SearchView = lazyRouteComponent(() => import("./views/search-view"), "SearchView");
const JobsView = lazyRouteComponent(() => import("./views/jobs-view"), "JobsView");
const SettingsView = lazyRouteComponent(() => import("./views/settings-view"), "SettingsView");
const DiscussionView = lazyRouteComponent(() => import("./views/coauthor-view"), "CoauthorView");
const HistoricalDiscussionReview = lazyRouteComponent(() => import("./views/discussion-view"), "DiscussionView");
const ReviewCenterView = lazyRouteComponent(() => import("./views/review-center-view"), "ReviewCenterView");
const KnowledgeRecordsView = lazyRouteComponent(() => import("./views/knowledge-records-view"), "KnowledgeRecordsView");
const AuthorSettingsView = lazyRouteComponent(() => import("./views/author-settings-view"), "AuthorSettingsView");
const ManuscriptSourceView = lazyRouteComponent(() => import("./views/manuscript-source-view"), "ManuscriptSourceView");
const DiscussionSourceView = lazyRouteComponent(() => import("./views/discussion-source-view"), "DiscussionSourceView");
const PlanningWorkspaceView = lazyRouteComponent(() => import("./views/planning-workspace-view"), "PlanningWorkspaceView");

function RouteErrorView({ error, reset }: { error: Error; reset: () => void }) {
  const goBack = () => {
    reset();
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.assign("/");
    }
  };

  return (
    <main className="fatal-error" role="alert">
      <h1>页面遇到问题</h1>
      <p>{error.message}</p>
      <button type="button" className="secondary-action" onClick={goBack}>返回</button>
    </main>
  );
}

function ProjectGate({ children }: { children: ReactNode }) {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  if (project.isPending) return <p className="route-loading">正在读取作品…</p>;
  if (project.isError) throw project.error;
  return project.data ? children : <EmptyProjectView />;
}

function ProjectIndexView() {
  const { manage } = useSearch({ from: "/" });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes, enabled: Boolean(project.data) && manage !== "1" });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections, enabled: Boolean(project.data) && manage !== "1" });
  if (manage === "1") return <EmptyProjectView />;
  if (project.isPending) return <p className="route-loading">正在读取作品…</p>;
  if (project.isError) throw project.error;
  if (!project.data) return <EmptyProjectView />;
  if (nodes.isPending || sections.isPending) return <p className="route-loading">正在读取创作进度…</p>;
  if (nodes.isError || sections.isError) throw nodes.error ?? sections.error;
  const preparationStarted = sections.data.some((section) => readPlanningReview(section));
  const preparationIncomplete = preparationStarted && !preparationProgress(buildPreparationStages(nodes.data), sections.data).ready;
  return <Navigate to={nodes.data.some((node) => node.kind === "CHAPTER" && !node.archived) && !preparationIncomplete ? "/writing" : "/planning"} replace />;
}

function PlanningEntryView() {
  return <ProjectGate><PlanningWorkspaceView /></ProjectGate>;
}

function WritingEntryView() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return <ProjectGate>{parseManuscriptSource(search) ? <ManuscriptSourceView search={search} />
    : <ProjectWorkspaceView mode="writing" />}</ProjectGate>;
}

function ChaptersEntryView() {
  return <WritingEntryView />;
}

function DiscussionEntryView() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return <ProjectGate>{parseDiscussionSource(search) ? <DiscussionSourceView search={search} />
    : new URLSearchParams(search).get("design") === "results" ? <HistoricalDiscussionReview /> : <DiscussionView />}</ProjectGate>;
}

function ReviewEntryView() {
  return <ProjectGate><ReviewCenterView /></ProjectGate>;
}

function JobsEntryView() {
  const hash = useRouterState({ select: (state) => state.location.hash });
  return hash === "quality" ? <Navigate to="/settings" hash="quality" replace /> : <ProjectGate><JobsView /></ProjectGate>;
}

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: EmptyProjectView,
  errorComponent: RouteErrorView,
  pendingComponent: () => <p className="route-loading">正在加载页面…</p>,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>) => ({ manage: search.manage === "1" || search.manage === 1 ? "1" : undefined }),
  component: ProjectIndexView,
});

const planningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/planning",
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> & { mode?: "structure" | "prepare"; item?: string } => ({
    ...search,
    mode: search.mode === "structure" ? "structure" as const : search.mode === "prepare" ? "prepare" as const : undefined,
    item: typeof search.item === "string" ? search.item : undefined,
  }),
  component: PlanningEntryView,
});
const preparationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/preparation",
  component: () => <Navigate to="/planning" search={{ mode: "prepare" }} replace />,
});

const writingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/writing",
  component: WritingEntryView,
});

const chaptersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chapters",
  component: ChaptersEntryView,
});

const discussionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discussion",
  component: DiscussionEntryView,
});

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge",
  loader: () => StoryBibleView.preload?.(),
  component: () => <ProjectGate><StoryBibleView /></ProjectGate>,
});
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/review", component: ReviewEntryView });
const knowledgeReviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/review", component: ReviewEntryView });
const knowledgeRecordsRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/knowledge/records",
  loader: () => KnowledgeRecordsView.preload?.(),
  component: () => <ProjectGate><KnowledgeRecordsView /></ProjectGate>,
});
const authorSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/knowledge/settings",
  loader: () => AuthorSettingsView.preload?.(),
  component: () => <ProjectGate><AuthorSettingsView /></ProjectGate>,
});
const materialsRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/knowledge/materials",
  loader: () => MaterialsView.preload?.(),
  component: () => <ProjectGate><MaterialsView /></ProjectGate>,
});
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/search", component: () => <ProjectGate><SearchView /></ProjectGate> });
const jobsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: JobsEntryView });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsView });

const routeTree = rootRoute.addChildren([indexRoute, preparationRoute, planningRoute, chaptersRoute, writingRoute, discussionRoute, knowledgeRoute, reviewRoute, knowledgeReviewRoute, knowledgeRecordsRoute, authorSettingsRoute, materialsRoute, searchRoute, jobsRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
