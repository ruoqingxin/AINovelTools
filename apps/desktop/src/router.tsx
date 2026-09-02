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
import { useQuery } from "@tanstack/react-query";
import { getCurrentProject } from "./lib/tauri-client";

function ProjectEntryView() {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  if (project.isPending) return <p className="route-loading">正在加载项目…</p>;
  return project.data ? <ProjectWorkspaceView /> : <EmptyProjectView />;
}

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: EmptyProjectView,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ProjectEntryView,
});

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge",
  component: StoryBibleView,
});
const knowledgeReviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/review", component: KnowledgeReviewView });
const materialsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge/materials", component: MaterialsView });
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/search", component: SearchView });
const jobsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: JobsView });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsView });

const routeTree = rootRoute.addChildren([indexRoute, knowledgeRoute, knowledgeReviewRoute, materialsRoute, searchRoute, jobsRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
