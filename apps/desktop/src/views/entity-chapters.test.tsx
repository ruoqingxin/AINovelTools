import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityChapters } from "./entity-chapters";
const mocks = vi.hoisted(() => ({ listEntityChapters: vi.fn(), listPlanNodes: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
function renderPanel() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <EntityChapters projectId="project-1" entityId="entity-1" />
  </QueryClientProvider>);
}
function expand() {
  const details = screen.getByText("关联章节").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
describe("entity chapter navigation", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listEntityChapters.mockResolvedValue([]);
    mocks.listPlanNodes.mockResolvedValue([{ id: "chapter-1", kind: "CHAPTER", title: "入城", archived: false }]);
  });
  it("loads only after expansion and builds an exact chapter link with an entity return", async () => {
    mocks.listEntityChapters.mockResolvedValue([{ chapterId: "chapter-1", title: "入城", archived: false }]);
    renderPanel();
    expect(mocks.listEntityChapters).not.toHaveBeenCalled();
    expect(mocks.listPlanNodes).not.toHaveBeenCalled();
    expand();
    const url = new URL((await screen.findByRole("link", { name: "入城" })).getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("referenceChapter")).toBe("chapter-1");
    expect(url.searchParams.get("returnTo")).toContain("entity=entity-1");
    expect(mocks.listEntityChapters).toHaveBeenCalledWith("project-1", "entity-1");
  });
  it("shows archived associations without offering an editing fallback", async () => {
    mocks.listEntityChapters.mockResolvedValue([{ chapterId: "old", title: "旧章", archived: true }]);
    renderPanel();
    expand();
    expect(await screen.findByText("旧章 · 已归档")).toBeVisible();
    expect(screen.queryByRole("link", { name: /旧章/ })).not.toBeInTheDocument();
  });
  it("chooses a new chapter destination without writing an association", async () => {
    renderPanel();
    expand();
    fireEvent.change(await screen.findByLabelText("选择关联目标章节"), { target: { value: "chapter-1" } });
    expect(screen.getByRole("link", { name: "打开章节计划" })).toHaveAttribute("href", expect.stringContaining("referenceChapter=chapter-1"));
  });
  it("retries the same failed entity lookup", async () => {
    mocks.listEntityChapters.mockRejectedValueOnce(new Error("关联读取失败")).mockResolvedValueOnce([]);
    renderPanel();
    expand();
    expect(await screen.findByRole("alert")).toHaveTextContent("关联读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无关联章节。")).toBeVisible();
    expect(mocks.listEntityChapters.mock.calls[0]).toEqual(mocks.listEntityChapters.mock.calls[1]);
  });
});
