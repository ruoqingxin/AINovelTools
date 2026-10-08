import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchView } from "./search-view";

const mocks = vi.hoisted(() => ({
  searchProject: vi.fn(),
  rebuildSearchIndex: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"),
  ...mocks,
}));

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SearchView /></QueryClientProvider>);
}

function result(index: number) {
  return { objectType: "ENTITY", objectId: `entity-${index}`, sourceVersion: "test:1", blockId: null, snippet: `result-${index}` };
}

describe("SearchView", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.searchProject.mockResolvedValue([]);
    mocks.rebuildSearchIndex.mockResolvedValue(undefined);
  });

  it("debounces input and searches only the final trimmed keyword", async () => {
    renderSearch();
    const input = screen.getByRole("textbox", { name: "搜索项目内容" });
    fireEvent.change(input, { target: { value: "n" } });
    fireEvent.change(input, { target: { value: "nov" } });
    fireEvent.change(input, { target: { value: " novel " } });
    expect(mocks.searchProject).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.searchProject).toHaveBeenCalledWith("novel", undefined, 50, 0));
    expect(mocks.searchProject).toHaveBeenCalledTimes(1);
  });

  it("appends pages and resets pagination when the filter changes", async () => {
    mocks.searchProject.mockImplementation((_query, type, _limit, offset) =>
      Promise.resolve(type ? [result(100)] : offset === 0 ? Array.from({ length: 50 }, (_, index) => result(index)) : [result(50)]));
    renderSearch();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "novel" } });
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("result-50")).toBeVisible();
    expect(screen.getByText("result-0")).toBeVisible();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "CARD" } });
    expect(await screen.findByText("result-100")).toBeVisible();
    expect(mocks.searchProject).toHaveBeenLastCalledWith("novel", "CARD", 50, 0);
    expect(screen.queryByText("result-0")).not.toBeInTheDocument();
  });

  it("does not search whitespace and hides results when the query is cleared", async () => {
    mocks.searchProject.mockResolvedValue([result(0)]);
    renderSearch();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    expect(mocks.searchProject).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "novel" } });
    expect(await screen.findByText("result-0")).toBeVisible();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText("result-0")).not.toBeInTheDocument();
  });

  it("disables duplicate rebuilds and reports rebuild failures", async () => {
    let rejectRebuild!: (error: Error) => void;
    mocks.rebuildSearchIndex.mockImplementation(() => new Promise((_resolve, reject) => { rejectRebuild = reject; }));
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: "重建索引" }));
    expect(await screen.findByRole("button", { name: "正在重建…" })).toBeDisabled();
    rejectRebuild(new Error("database unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("索引重建失败：database unavailable");
    expect(screen.getByRole("button", { name: "重建索引" })).toBeEnabled();
  });

  it("refreshes active results after rebuilding the index", async () => {
    renderSearch();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "novel" } });
    await screen.findByText("没有匹配结果。");
    mocks.searchProject.mockResolvedValue([result(0)]);
    fireEvent.click(screen.getByRole("button", { name: "重建索引" }));
    expect(await screen.findByText("result-0")).toBeVisible();
    expect(mocks.rebuildSearchIndex).toHaveBeenCalledTimes(1);
  });
});
