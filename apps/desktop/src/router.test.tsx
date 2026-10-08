import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "./router";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn() }));

vi.mock("./lib/tauri-client", () => mocks);
vi.mock("./shell/app-shell", () => ({ AppShell: () => <Outlet /> }));
vi.mock("./views/empty-project-view", () => ({ EmptyProjectView: () => <p>No project</p> }));
vi.mock("./views/project-workspace-view", () => ({
  ProjectWorkspaceView: ({ mode = "planning" }: { mode?: string }) => <p>Workspace {mode}</p>,
}));
vi.mock("./views/discussion-view", () => ({ DiscussionView: () => <p>Discussion</p> }));
vi.mock("./views/review-center-view", () => ({ ReviewCenterView: () => <p>Review</p> }));
vi.mock("./views/settings-view", () => ({ SettingsView: () => <p>Settings</p> }));

function renderRoute(path: string) {
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMinMs: 0,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={testRouter} /></QueryClientProvider>);
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

  it.each([
    ["/planning", "Workspace planning"],
    ["/writing", "Workspace writing"],
    ["/chapters", "Workspace chapters"],
    ["/discussion", "Discussion"],
    ["/review", "Review"],
    ["/knowledge/review", "Review"],
    ["/settings", "Settings"],
  ])("loads %s on demand", async (path, label) => {
    renderRoute(path);
    expect(await screen.findByText(label)).toBeVisible();
  });

  it("shows the project entry when no project is open", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    renderRoute("/writing");
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
