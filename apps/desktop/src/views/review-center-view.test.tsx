import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCenterView } from "./review-center-view";

const mocks = vi.hoisted(() => ({ listAuthorTodos: vi.fn(), listPlanNodes: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks }));
function renderView() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ReviewCenterView /></QueryClientProvider>);
}
describe("author to-dos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/review");
    mocks.listAuthorTodos.mockResolvedValue({ projectId: "project-1", pendingCount: 3, items: [
      { kind: "FACT_REVIEW", targetId: "chapter-1", targetTitle: "入城", count: 2, highRisk: true, updatedAt: "0" },
      { kind: "FACT_FINALIZE", targetId: "chapter-2", targetTitle: "铜铃", count: 1, highRisk: false, updatedAt: "0" },
    ] });
  });
  afterEach(cleanup);
  it("shows real pending counts and distinct approval/finalization states without checking forms", async () => {
    renderView();
    expect(await screen.findByText("3 项待处理")).toBeVisible();
    expect(screen.getByText("待批准")).toBeVisible();
    expect(screen.getByText("已批准 · 待定稿")).toBeVisible();
    expect(screen.getByText("冲突阻断定稿")).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(mocks.listPlanNodes).not.toHaveBeenCalled();
    const url = new URL(screen.getByRole("link", { name: "审核事实" }).getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("referenceChapter")).toBe("chapter-1");
    expect(url.searchParams.get("targetProject")).toBe("project-1");
    expect(url.searchParams.get("knowledge")).toBe("facts");
  });
  it("filters the list and refreshes the same queue", async () => {
    renderView();
    await screen.findByText("3 项待处理");
    fireEvent.change(screen.getByLabelText("待办类型"), { target: { value: "FACT_FINALIZE" } });
    expect(screen.queryByText("入城")).not.toBeInTheDocument();
    mocks.listAuthorTodos.mockResolvedValue({ projectId: "project-1", pendingCount: 0, items: [] });
    fireEvent.click(screen.getByLabelText("刷新待办"));
    await screen.findByText("0 项待处理");
    expect(screen.getByText("此类暂无待办")).toBeVisible();
  });
  it("returns to all pending work from an empty category", async () => {
    renderView();
    await screen.findByText("3 项待处理");
    fireEvent.change(screen.getByLabelText("待办类型"), { target: { value: "FACT_REVIEW" } });
    expect(screen.getByText("入城")).toBeVisible();
    fireEvent.change(screen.getByLabelText("待办类型"), { target: { value: "WRITING_PROPOSAL" } });
    expect(screen.getByText("此类暂无待办")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看全部待办" }));
    expect(screen.getByLabelText("待办类型")).toHaveValue("ALL");
    expect(screen.getByText("铜铃")).toBeVisible();
  });
  it("retains the legacy chapter and check purpose as a workspace entry", async () => {
    window.history.replaceState({}, "", "/review?tab=admission&chapterId=chapter-2");
    renderView();
    const url = new URL(screen.getByRole("link", { name: "打开生成前检查" }).getAttribute("href")!, window.location.origin);
    expect(url.hash).toBe("#chapter-2");
    expect(url.searchParams.get("assistant")).toBe("review");
    expect(url.searchParams.get("purpose")).toBe("admission");
  });
  it("reports query failure and supports refresh", async () => {
    mocks.listAuthorTodos.mockRejectedValueOnce(new Error("queue unavailable"));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("queue unavailable");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(screen.getByText("3 项待处理")).toBeVisible());
  });
});
