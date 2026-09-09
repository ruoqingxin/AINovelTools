import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "./shell/app-shell";
import { EmptyProjectView } from "./views/empty-project-view";
import { ProjectWorkspaceView } from "./views/project-workspace-view";
import { StoryBibleView } from "./views/story-bible-view";
import { MaterialsView } from "./views/materials-view";
import { SearchView } from "./views/search-view";
import { JobsView } from "./views/jobs-view";
import { SettingsView } from "./views/settings-view";
import { KnowledgeReviewView } from "./views/knowledge-review-view";
import { KnowledgeRecordsView } from "./views/knowledge-records-view";
import { useQuery } from "@tanstack/react-query";
import { getCurrentProject } from "./lib/tauri-client";

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

function ProjectEntryView() {
  return <EmptyProjectView />;
}

function PlanningEntryView() {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  if (project.isPending) return <p className="route-loading">正在加载项目…</p>;
  return project.data ? <ProjectWorkspaceView /> : <EmptyProjectView />;
}

function WritingEntryView() {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  if (project.isPending) return <p className="route-loading">正在加载项目…</p>;
  return project.data ? <ProjectWorkspaceView mode="writing" /> : <EmptyProjectView />;
}

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: EmptyProjectView,
  errorComponent: RouteErrorView,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ProjectEntryView,
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

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge",
  component: StoryBibleView,
});
const knowledgeReviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/review", component: KnowledgeReviewView });
const knowledgeRecordsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/records", component: KnowledgeRecordsView });
const materialsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/materials", component: MaterialsView });
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/search", component: SearchView });
const jobsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: JobsView });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsView });

const routeTree = rootRoute.addChildren([indexRoute, planningRoute, writingRoute, knowledgeRoute, knowledgeReviewRoute, knowledgeRecordsRoute, materialsRoute, searchRoute, jobsRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
