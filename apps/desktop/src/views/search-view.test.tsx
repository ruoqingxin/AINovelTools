import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchView } from "./search-view";

const mocks = vi.hoisted(() => ({
  searchProject: vi.fn(),
  rebuildSearchIndex: vi.fn(),
  getCurrentProject: vi.fn(),
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
  afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.searchProject.mockResolvedValue([]);
    mocks.rebuildSearchIndex.mockResolvedValue(undefined);
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
  });

  it("focuses the keyword field as soon as search opens", () => {
    renderSearch();
    expect(screen.getByRole("textbox", { name: "搜索项目内容" })).toHaveFocus();
    expect(screen.getByText("尚未搜索")).toBeVisible();
  });

  it("resets the results panel when the keyword or object filter changes", async () => {
    window.history.replaceState(null, "", "/search?q=first");
    mocks.searchProject.mockResolvedValue([result(1)]);
    renderSearch();
    await screen.findByText("result-1");
    const panel = document.querySelector<HTMLDivElement>(".search-results")!;
    panel.scrollTop = 400;
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "CARD" } });
    expect(panel.scrollTop).toBe(0);
    panel.scrollTop = 400;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second" } });
    await waitFor(() => expect(mocks.searchProject).toHaveBeenCalledWith("second", "CARD", 50, 0));
    expect(panel.scrollTop).toBe(0);
  });

  it("shows real titles, chapter and revision metadata and highlights literal keywords safely", async () => {
    window.history.replaceState(null, "", "/search?q=A%2BB");
    mocks.searchProject.mockResolvedValue([{ ...result(1), title: "铜铃旧案", chapterTitle: "入城",
      updatedAt: "2026-10-14T10:00:00Z", snippet: "A+B 与 a+b <script>未知</script>" }]);
    renderSearch();
    expect(await screen.findByRole("heading", { name: "铜铃旧案" })).toBeVisible();
    expect(screen.getByText("入城")).toBeVisible();
    expect(screen.getByText(/更新于/).closest("time")).toHaveAttribute("dateTime", "2026-10-14T10:00:00Z");
    expect([...document.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["A+B", "a+b"]);
    expect(document.querySelector(".search-result script")).toBeNull();
    expect(document.querySelector(".search-result")).toHaveTextContent("<script>未知</script>");
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

  it("opens the current entity with exact project identity and search filters", async () => {
    window.history.replaceState(null, "", "/search?q=沈砚&type=ENTITY");
    mocks.searchProject.mockResolvedValue([result(1)]);
    renderSearch();
    const url = new URL((await screen.findByRole("link", { name: "打开当前实体" })).getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("entity")).toBe("entity-1");
    expect(url.searchParams.get("targetProject")).toBe("project-1");
    const back = new URL(url.searchParams.get("returnTo")!, window.location.origin);
    expect(back.pathname).toBe("/search");
    expect(back.searchParams.get("q")).toBe("沈砚");
    expect(back.searchParams.get("type")).toBe("ENTITY");
  });

  it.each([
    ["SUMMARY", "打开当前摘要", "/knowledge/materials", "summary"],
    ["CARD", "打开当前卡片", "/knowledge/materials", "card"],
    ["PLAN", "打开当前规划", "/planning", "planNode"],
  ])("opens an exact %s object with project identity and a filtered return", async (objectType, label, pathname, field) => {
    window.history.replaceState(null, "", `/search?q=雾城&type=${objectType}`);
    mocks.searchProject.mockResolvedValue([{ ...result(1), objectType, objectId: "exact-object" }]);
    renderSearch();
    const url = new URL((await screen.findByRole("link", { name: label })).getAttribute("href")!, window.location.origin);
    expect(url.pathname).toBe(pathname);
    expect(url.searchParams.get(field)).toBe("exact-object");
    expect(url.searchParams.get("targetProject")).toBe("project-1");
    const back = new URL(url.searchParams.get("returnTo")!, window.location.origin);
    expect(back.searchParams.get("q")).toBe("雾城");
    expect(back.searchParams.get("type")).toBe(objectType);
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

  it("keeps maintenance out of normal search", async () => {
    renderSearch();
    expect(screen.queryByRole("button", { name: /重建/ })).not.toBeInTheDocument();
    expect(mocks.rebuildSearchIndex).not.toHaveBeenCalled();
  });

  it("links search errors to data repair without a duplicate rebuild command", async () => {
    mocks.searchProject.mockRejectedValue(new Error("index unavailable"));
    renderSearch();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "novel" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("index unavailable");
    expect(screen.getByRole("link", { name: "前往数据管理修复" })).toHaveAttribute("href", "/settings#data-management");
    mocks.searchProject.mockResolvedValue([result(1)]);
    fireEvent.click(screen.getByRole("button", { name: "重试搜索" }));
    expect(await screen.findByText("result-1")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("novel");
    expect(mocks.rebuildSearchIndex).not.toHaveBeenCalled();
  });

  it("widens an empty filtered search without losing the keyword", async () => {
    window.history.replaceState(null, "", "/search?q=雾城&type=CARD");
    mocks.searchProject.mockImplementation(async (_query, type) => type ? [] : [result(1)]);
    renderSearch();
    fireEvent.click(await screen.findByRole("button", { name: "搜索全部类型" }));
    expect(await screen.findByText("result-1")).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveValue("雾城");
  });

  it("clears the current search with one click and keeps focus", async () => {
    window.history.replaceState(null, "", "/search?q=雾城&type=CARD");
    mocks.searchProject.mockResolvedValue([result(1)]);
    renderSearch();
    await screen.findByText("result-1");
    fireEvent.click(screen.getByRole("button", { name: "清空搜索项目内容" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveValue("CARD");
    expect(screen.queryByText("result-1")).not.toBeInTheDocument();
  });

  it("recovers a project read failure without leaving an indefinite searching state", async () => {
    window.history.replaceState(null, "", "/search?q=雾城");
    mocks.getCurrentProject.mockRejectedValueOnce(new Error("project unavailable"));
    renderSearch();
    expect(await screen.findByRole("alert")).toHaveTextContent("project unavailable");
    expect(screen.queryByText("正在搜索…")).not.toBeInTheDocument();
    expect(mocks.searchProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("没有匹配结果。");
    expect(mocks.searchProject).toHaveBeenCalledWith("雾城", undefined, 50, 0);
  });

  it("does not show a permanent loading state when no project is open", async () => {
    window.history.replaceState(null, "", "/search?q=雾城");
    mocks.getCurrentProject.mockResolvedValue(null);
    renderSearch();
    expect(await screen.findByText("尚未打开作品")).toBeVisible();
    expect(screen.queryByText("正在搜索…")).not.toBeInTheDocument();
    expect(mocks.searchProject).not.toHaveBeenCalled();
  });

  it("restores query and filter and links an exact manuscript revision with its return context", async () => {
    window.history.replaceState(null, "", "/search?q=%E9%9B%BE%E5%9F%8E&type=MANUSCRIPT");
    mocks.searchProject.mockResolvedValue([{ objectType: "MANUSCRIPT", objectId: "old-revision",
      sourceVersion: "manuscript:old-revision", blockId: "block:1", snippet: "旧原文" }]);
    renderSearch();
    expect(screen.getByRole("textbox")).toHaveValue("雾城");
    expect(screen.getByRole("combobox")).toHaveValue("MANUSCRIPT");
    const url = new URL((await screen.findByRole("link", { name: "定位原文" })).getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("sourceProject")).toBe("project-1");
    expect(url.searchParams.get("sourceRevision")).toBe("old-revision");
    expect(url.searchParams.get("sourceBlock")).toBe("block:1");
    expect(new URL(url.searchParams.get("returnTo")!, window.location.origin).searchParams.get("q")).toBe("雾城");
    expect(mocks.searchProject).toHaveBeenCalledWith("雾城", "MANUSCRIPT", 50, 0);
  });
});
