import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "./router";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn(), loadAuthorSettings: vi.fn() }));

vi.mock("./lib/tauri-client", () => mocks);
vi.mock("./shell/app-shell", () => ({ AppShell: () => <Outlet /> }));
vi.mock("./views/empty-project-view", () => ({ EmptyProjectView: () => <p>No project</p> }));
vi.mock("./views/project-workspace-view", () => ({
  ProjectWorkspaceView: ({ mode = "planning" }: { mode?: string }) => <p>Workspace {mode}</p>,
}));
vi.mock("./views/discussion-view", () => ({ DiscussionView: () => <p>Discussion</p> }));
vi.mock("./views/review-center-view", () => ({ ReviewCenterView: () => <p>Review</p> }));
vi.mock("./views/settings-view", () => ({ SettingsView: () => <p>Settings</p> }));
vi.mock("./views/story-bible-view", () => ({ StoryBibleView: () => <p>Materials entities</p> }));
vi.mock("./views/materials-view", () => ({ MaterialsView: () => <p>Materials references</p> }));
vi.mock("./views/knowledge-records-view", () => ({ KnowledgeRecordsView: () => <p>Materials records</p> }));
vi.mock("./views/author-settings-view", async () => {
  await mocks.loadAuthorSettings();
  return { AuthorSettingsView: () => <p>Materials settings</p> };
});
vi.mock("./views/search-view", () => ({ SearchView: () => <p>Search</p> }));
vi.mock("./views/jobs-view", () => ({ JobsView: () => <p>Activity</p> }));
vi.mock("./views/manuscript-source-view", () => ({ ManuscriptSourceView: () => <p>Verified source</p> }));
vi.mock("./views/discussion-source-view", () => ({ DiscussionSourceView: () => <p>Verified discussion source</p> }));

function renderRoute(path: string) {
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMinMs: 0,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={testRouter} /></QueryClientProvider>);
  return testRouter;
}

describe("project routes", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
  });

  it("keeps the current knowledge page visible while a cold tab component loads", async () => {
    let release!: () => void;
    mocks.loadAuthorSettings.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const testRouter = renderRoute("/knowledge");
    await screen.findByText("Materials entities");
    let navigation!: Promise<void>;
    act(() => { navigation = testRouter.navigate({ to: "/knowledge/settings" }); });
    try {
      await waitFor(() => expect(mocks.loadAuthorSettings).toHaveBeenCalled());
      expect(screen.getByText("Materials entities")).toBeVisible();
      expect(screen.queryByText("Materials settings")).not.toBeInTheDocument();
    } finally {
      await act(async () => { release(); await navigation; });
    }
    expect(await screen.findByText("Materials settings")).toBeVisible();
  });

  it.each([
    ["/planning", "Workspace planning"],
    ["/writing", "Workspace writing"],
    ["/chapters", "Workspace writing"],
    ["/writing?sourceRevision=old-revision", "Verified source"],
    ["/chapters?sourceEvidence=anchor-1", "Verified source"],
    ["/writing?sourceRevision=", "Verified source"],
    ["/discussion", "Discussion"],
    ["/discussion?sourceCandidate=old-candidate", "Verified discussion source"],
    ["/discussion?sourceCandidate=", "Verified discussion source"],
    ["/review", "Review"],
    ["/knowledge/review", "Review"],
    ["/settings", "Settings"],
    ["/knowledge", "Materials entities"],
    ["/knowledge/materials", "Materials references"],
    ["/knowledge/records", "Materials records"],
    ["/knowledge/settings", "Materials settings"],
    ["/search", "Search"],
    ["/jobs", "Activity"],
    ["/jobs#quality", "Settings"],
    ["/", "Workspace writing"],
    ["/?manage=1", "No project"],
  ])("loads %s on demand", async (path, label) => {
    renderRoute(path);
    expect(await screen.findByText(label)).toBeVisible();
  });

  it.each(["/", "/writing", "/knowledge", "/knowledge/materials", "/knowledge/records", "/knowledge/settings", "/search", "/jobs"])
  ("shows the project entry on %s when no project is open", async (path) => {
    mocks.getCurrentProject.mockResolvedValue(null);
    renderRoute(path);
    expect(await screen.findByText("No project")).toBeVisible();
    expect(screen.queryByText("Workspace writing")).not.toBeInTheDocument();
  });

  it("reports project loading errors instead of treating them as an unopened project", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.getCurrentProject.mockRejectedValue(new Error("project unavailable"));
      renderRoute("/writing");
      expect(await screen.findByRole("alert")).toHaveTextContent("project unavailable");
      expect(screen.queryByText("No project")).not.toBeInTheDocument();
    } finally {
      warning.mockRestore();
      error.mockRestore();
    }
  });
});
