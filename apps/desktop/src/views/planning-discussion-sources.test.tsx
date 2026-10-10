import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningDiscussionSources } from "./planning-discussion-sources";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn(), listPlanningDiscussionSources: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
const record = (index: number) => ({ projectId: "project-1", sessionTitle: `原讨论 ${index}`,
  candidate: { id: `candidate-${index}`, sessionId: "session-1", content: `候选 ${index}`, targetSectionId: "seed-premise" } });
function renderList(active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (next: boolean) => <QueryClientProvider client={client}>
    <PlanningDiscussionSources sectionId="seed-premise" active={next} />
  </QueryClientProvider>;
  return { ...render(ui(active)), client, ui };
}
function expand() {
  const details = screen.getByText("讨论流转记录").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("lazy discussion transfer records", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listPlanningDiscussionSources.mockResolvedValue([]);
  });
  it("reads only after expansion, then pauses invalidated queries while hidden", async () => {
    const { rerender, client, ui } = renderList();
    expect(mocks.getCurrentProject).not.toHaveBeenCalled();
    expect(mocks.listPlanningDiscussionSources).not.toHaveBeenCalled();
    expand();
    expect(await screen.findByText("暂无讨论流转记录。")).toBeVisible();
    expect(mocks.listPlanningDiscussionSources).toHaveBeenCalledWith("seed-premise", "project-1", 20, 0);
    rerender(ui(false));
    await client.invalidateQueries({ queryKey: ["planning-discussion-sources"] });
    expect(mocks.listPlanningDiscussionSources).toHaveBeenCalledTimes(1);
    rerender(ui(true));
    await waitFor(() => expect(mocks.listPlanningDiscussionSources).toHaveBeenCalledTimes(2));
  });
  it("paginates twenty records and preserves the exact section and return context", async () => {
    mocks.listPlanningDiscussionSources.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => record(i))).mockResolvedValueOnce([record(20)]);
    renderList();
    expand();
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("原讨论 20")).toBeVisible();
    expect(mocks.listPlanningDiscussionSources).toHaveBeenLastCalledWith("seed-premise", "project-1", 20, 20);
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    const url = new URL(screen.getAllByRole("link", { name: "查看讨论来源" })[0].getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("sourceCandidate")).toBe("candidate-0");
    expect(url.searchParams.get("sourceSection")).toBe("seed-premise");
    expect(url.searchParams.get("sourceProject")).toBe("project-1");
    expect(url.searchParams.get("returnTo")).toContain("/planning?discussionTarget=seed-premise");
  });
  it("keeps failures explicit and retries without selecting another section", async () => {
    mocks.listPlanningDiscussionSources.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce([record(1)]);
    renderList();
    expand();
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("原讨论 1")).toBeVisible();
    expect(mocks.listPlanningDiscussionSources.mock.calls[0]).toEqual(mocks.listPlanningDiscussionSources.mock.calls[1]);
  });
  it("does not query records without a current project", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    renderList();
    expand();
    expect(await screen.findByText("未打开来源项目。")).toBeVisible();
    expect(mocks.listPlanningDiscussionSources).not.toHaveBeenCalled();
  });
});
