import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialsView } from "./materials-view";

const mocks = vi.hoisted(() => ({
  getCurrentProject: vi.fn(), getSummaryMaterial: vi.fn(), getWritingCard: vi.fn(),
  listSummaryMaterials: vi.fn(), listWritingCards: vi.fn(), listJobs: vi.fn(),
  upsertSummaryMaterial: vi.fn(), upsertWritingCard: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
const summary = {
  id: "summary-1", projectId: "project-1", kind: "CHAPTER", precision: "L0",
  sourceId: "chapter-1", sourceVersion: "manuscript:11111111-1111-1111-1111-111111111111",
  content: "旧修订的摘要内容", generationMode: "EXTRACTIVE_AUTO", lifecycleStatus: "STALE", createdAt: "0", updatedAt: "1",
};

function renderTarget(search = "?summary=summary-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D城%26type%3DSUMMARY") {
  window.history.replaceState(null, "", `/knowledge/materials${search}`);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MaterialsView /></QueryClientProvider>);
}

describe("material detail navigation", () => {
  afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.getSummaryMaterial.mockResolvedValue(summary);
    mocks.getWritingCard.mockResolvedValue({
      id: "card-1", projectId: "project-1", title: "短句节奏", content: "当前卡片内容", enabled: false,
      sourceVersion: "author:manual", scope: "PROJECT", updatedAt: "2",
    });
  });

  it("reads only the exact summary and stays read-only", async () => {
    renderTarget();
    expect(await screen.findByText(summary.content)).toBeVisible();
    expect(mocks.getSummaryMaterial).toHaveBeenCalledWith("summary-1", "project-1");
    expect(screen.getByText("已失效")).toBeVisible();
    const back = new URL(screen.getByRole("link", { name: "返回来源" }).getAttribute("href")!, window.location.origin);
    expect(back.searchParams.get("q")).toBe("城");
    expect(back.searchParams.get("type")).toBe("SUMMARY");
    const url = new URL(screen.getByRole("link", { name: "查看摘要来源正文" }).getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("sourceRevision")).toBe("11111111-1111-1111-1111-111111111111");
    expect(new URL(url.searchParams.get("returnTo")!, window.location.origin).searchParams.get("summary")).toBe("summary-1");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocks.listSummaryMaterials).not.toHaveBeenCalled();
    expect(mocks.listWritingCards).not.toHaveBeenCalled();
    expect(mocks.listJobs).not.toHaveBeenCalled();
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
  });

  it("opens a disabled card as current content, not a historic source", async () => {
    renderTarget("?card=card-1&targetProject=project-1");
    expect(await screen.findByRole("heading", { name: "短句节奏" })).toBeVisible();
    expect(mocks.getWritingCard).toHaveBeenCalledWith("card-1", "project-1");
    expect(mocks.getSummaryMaterial).not.toHaveBeenCalled();
    expect(screen.getByText("已停用 · PROJECT")).toBeVisible();
    expect(screen.queryByRole("link", { name: "查看摘要来源正文" })).not.toBeInTheDocument();
    expect(mocks.upsertWritingCard).not.toHaveBeenCalled();
  });

  it.each([
    "?summary=&targetProject=project-1", "?summary=summary-1&targetProject=foreign",
    "?summary=summary-1", "?summary=summary-1&card=card-1&targetProject=project-1",
  ])("rejects invalid links without loading a list or another object: %s", async (search) => {
    renderTarget(search);
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他资料");
    expect(mocks.getSummaryMaterial).not.toHaveBeenCalled();
    expect(mocks.getWritingCard).not.toHaveBeenCalled();
    expect(mocks.listSummaryMaterials).not.toHaveBeenCalled();
    expect(screen.queryByText(summary.content)).not.toBeInTheDocument();
  });

  it("reports a missing object and retries the same identity", async () => {
    mocks.getSummaryMaterial.mockRejectedValueOnce(new Error("资料不存在"));
    renderTarget();
    expect(await screen.findByRole("alert")).toHaveTextContent("资料不存在");
    expect(screen.queryByText(summary.content)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(summary.content)).toBeVisible();
    expect(mocks.getSummaryMaterial).toHaveBeenLastCalledWith("summary-1", "project-1");
  });

  it("can refresh current content without mutating its status", async () => {
    renderTarget();
    await screen.findByText(summary.content);
    mocks.getSummaryMaterial.mockResolvedValue({ ...summary, content: "后来更新的摘要" });
    fireEvent.click(screen.getByRole("button", { name: "刷新当前内容" }));
    expect(await screen.findByText("后来更新的摘要")).toBeVisible();
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
  });

  it("does not expose an external return or a manual label as manuscript evidence", async () => {
    mocks.getSummaryMaterial.mockResolvedValue({ ...summary, generationMode: "MANUAL_REFERENCE" });
    renderTarget("?summary=summary-1&targetProject=project-1&returnTo=https%3A%2F%2Fother.test");
    await screen.findByText(summary.content);
    expect(screen.queryByRole("link", { name: "返回来源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看摘要来源正文" })).not.toBeInTheDocument();
  });
});
