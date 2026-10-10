import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "./shell/app-shell";
import { EmptyProjectView } from "./views/empty-project-view";
import { useQuery } from "@tanstack/react-query";
import { getCurrentProject } from "./lib/tauri-client";
import { parseManuscriptSource } from "./lib/manuscript-source";
import { parseDiscussionSource } from "./lib/discussion-source";

const ProjectWorkspaceView = lazyRouteComponent(() => import("./views/project-workspace-view"), "ProjectWorkspaceView");
const StoryBibleView = lazyRouteComponent(() => import("./views/story-bible-view"), "StoryBibleView");
const MaterialsView = lazyRouteComponent(() => import("./views/materials-view"), "MaterialsView");
const SearchView = lazyRouteComponent(() => import("./views/search-view"), "SearchView");
const JobsView = lazyRouteComponent(() => import("./views/jobs-view"), "JobsView");
const SettingsView = lazyRouteComponent(() => import("./views/settings-view"), "SettingsView");
const DiscussionView = lazyRouteComponent(() => import("./views/discussion-view"), "DiscussionView");
const ReviewCenterView = lazyRouteComponent(() => import("./views/review-center-view"), "ReviewCenterView");
const KnowledgeRecordsView = lazyRouteComponent(() => import("./views/knowledge-records-view"), "KnowledgeRecordsView");
const AuthorSettingsView = lazyRouteComponent(() => import("./views/author-settings-view"), "AuthorSettingsView");
const ManuscriptSourceView = lazyRouteComponent(() => import("./views/manuscript-source-view"), "ManuscriptSourceView");
const DiscussionSourceView = lazyRouteComponent(() => import("./views/discussion-source-view"), "DiscussionSourceView");

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
  if (project.isPending) return <p className="route-loading">正在加载项目…</p>;
  if (project.isError) throw project.error;
  return project.data ? children : <EmptyProjectView />;
}

function PlanningEntryView() {
  return <ProjectGate><ProjectWorkspaceView /></ProjectGate>;
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
  return <ProjectGate>{parseDiscussionSource(search) ? <DiscussionSourceView search={search} /> : <DiscussionView />}</ProjectGate>;
}

function ReviewEntryView() {
  return <ProjectGate><ReviewCenterView /></ProjectGate>;
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
  component: EmptyProjectView,
});

const planningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/planning",
  component: PlanningEntryView,
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
  component: StoryBibleView,
});
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/review", component: ReviewEntryView });
const knowledgeReviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/review", component: ReviewEntryView });
const knowledgeRecordsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/records", component: KnowledgeRecordsView });
const authorSettingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/settings", component: AuthorSettingsView });
const materialsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/materials", component: MaterialsView });
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/search", component: SearchView });
const jobsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: JobsView });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsView });

const routeTree = rootRoute.addChildren([indexRoute, planningRoute, chaptersRoute, writingRoute, discussionRoute, knowledgeRoute, reviewRoute, knowledgeReviewRoute, knowledgeRecordsRoute, authorSettingsRoute, materialsRoute, searchRoute, jobsRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
