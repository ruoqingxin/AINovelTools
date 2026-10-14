import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialsView } from "./materials-view";

const mocks = vi.hoisted(() => ({
  listSummaryMaterials: vi.fn(), listWritingCards: vi.fn(), getCurrentProject: vi.fn(), listPlanNodes: vi.fn(),
  setSummaryMaterialLifecycle: vi.fn(), upsertSummaryMaterial: vi.fn(), upsertWritingCard: vi.fn(),
  enqueueChapterSummaryRefresh: vi.fn(), enqueueProjectSettingSummaryRefresh: vi.fn(), listJobs: vi.fn(),
  rebuildSummaryMaterial: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    ...mocks,
  };
});

const summary = {
  id: "summary-1", projectId: "project-1", kind: "CHAPTER", precision: "L1", sourceId: "chapter-1",
  sourceVersion: "manuscript:11111111-1111-1111-1111-111111111111", content: "章节记忆正文",
  generationMode: "EXTRACTIVE_AUTO", lifecycleStatus: "STALE", createdAt: "", updatedAt: "",
};
function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MaterialsView /></QueryClientProvider>);
  return client;
}
async function selectSummary() { fireEvent.click(await screen.findByRole("button", { name: /章节记忆正文/ })); }
describe("MaterialsView", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState(null, "", "/knowledge/materials");
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listSummaryMaterials.mockResolvedValue([]);
    mocks.listWritingCards.mockResolvedValue([]);
    mocks.listPlanNodes.mockResolvedValue([]);
    mocks.setSummaryMaterialLifecycle.mockResolvedValue({});
    mocks.listJobs.mockResolvedValue([]);
    mocks.upsertSummaryMaterial.mockImplementation(async (value) => value);
    mocks.upsertWritingCard.mockImplementation(async (value) => value);
  });
  it("starts in list/detail mode and opens only the requested creation form", async () => {
    renderView();
    expect(screen.getByRole("heading", { name: "参考资料" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "摘要内容" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    expect(screen.getByRole("button", { name: "保存摘要" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "作者参考" } });
    fireEvent.click(screen.getByRole("button", { name: "保存摘要" }));
    await waitFor(() => expect(mocks.upsertSummaryMaterial).toHaveBeenCalledWith(expect.objectContaining({
      content: "作者参考", generationMode: "MANUAL_REFERENCE", precision: "L0", lifecycleStatus: "ACTIVE",
    })));
  });
  it("identifies chapter memories by source chapter and searches those names", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([{ ...summary, updatedAt: "2026-10-14T10:00:00Z" }]);
    mocks.listPlanNodes.mockResolvedValue([{ id: "chapter-1", kind: "CHAPTER", title: "铜铃旧案" }]);
    renderView();
    expect(await screen.findByText("章节记忆 · 铜铃旧案")).toBeVisible();
    fireEvent.change(screen.getByLabelText("搜索参考资料"), { target: { value: "铜铃旧案" } });
    fireEvent.click(screen.getByRole("button", { name: /章节记忆 · 铜铃旧案/ }));
    expect(screen.getByRole("heading", { name: "章节记忆 · 铜铃旧案" })).toBeVisible();
    expect(screen.getAllByText(/更新于/)).toHaveLength(2);
    expect(mocks.listPlanNodes).toHaveBeenCalledOnce();
  });
  it("shows separate list and detail states on mobile and preserves filters and scroll on return", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    try {
      mocks.listSummaryMaterials.mockResolvedValue([summary]);
      renderView();
      const list = document.querySelector<HTMLElement>(".library-list")!;
      expect(document.querySelector(".library-detail")).not.toBeVisible();
      list.scrollTop = 145;
      fireEvent.change(screen.getByLabelText("搜索参考资料"), { target: { value: "章节记忆" } });
      const scroll = vi.fn();
      document.querySelector<HTMLElement>(".library-detail")!.scrollIntoView = scroll;
      await selectSummary();
      expect(list).not.toBeVisible();
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      fireEvent.click(screen.getByRole("button", { name: "编辑参考副本" }));
      expect(scroll).toHaveBeenCalledTimes(2);
      fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "未保存编辑" } });
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      fireEvent.click(screen.getByRole("button", { name: "返回资料列表" }));
      expect(screen.getByLabelText("摘要内容")).toHaveValue("未保存编辑");
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "返回资料列表" }));
      expect(list).toBeVisible();
      expect(screen.getByLabelText("搜索参考资料")).toHaveValue("章节记忆");
      await waitFor(() => expect(list.scrollTop).toBe(145));
    } finally { media.mockRestore(); }
  });
  it("renders large lists in batches while searching the full collection", async () => {
    mocks.listWritingCards.mockResolvedValue(Array.from({ length: 205 }, (_, index) => ({
      id: `card-${index}`, title: `卡片 ${index}`, content: `正文 ${index}`, enabled: true, cardType: "STYLE_RULE",
    })));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "写作卡片" }));
    expect(await screen.findByRole("button", { name: /卡片 99 / })).toBeVisible();
    expect(screen.queryByRole("button", { name: /卡片 100 / })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示更多资料" }));
    expect(screen.getByRole("button", { name: /卡片 199 / })).toBeVisible();
    fireEvent.change(screen.getByLabelText("搜索参考资料"), { target: { value: "卡片 204" } });
    expect(screen.getByRole("button", { name: /卡片 204 / })).toBeVisible();
    expect(screen.queryByRole("button", { name: "显示更多资料" })).not.toBeInTheDocument();
  });
  it("activates a candidate without exposing duplicate restore commands", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([{ ...summary, generationMode: "AI", lifecycleStatus: "CANDIDATE" }]);
    renderView(); await selectSummary();
    fireEvent.click(screen.getByRole("button", { name: "确认为有效" }));
    await waitFor(() => expect(mocks.setSummaryMaterialLifecycle).toHaveBeenCalledWith("summary-1", "ACTIVE"));
    expect(screen.queryByRole("button", { name: /恢复/ })).not.toBeInTheDocument();
  });
  it("copies an automatic summary without overwriting the original or its provenance", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    renderView(); await selectSummary();
    fireEvent.click(screen.getByRole("button", { name: "编辑参考副本" }));
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "手工改写" } });
    fireEvent.click(screen.getByRole("button", { name: "另存为参考摘要" }));
    await waitFor(() => expect(mocks.upsertSummaryMaterial).toHaveBeenCalled());
    const saved = mocks.upsertSummaryMaterial.mock.calls[0][0];
    expect(saved.id).not.toBe(summary.id);
    expect(saved).toMatchObject({ content: "手工改写", generationMode: "MANUAL_REFERENCE", precision: "L0",
      sourceId: summary.sourceId, sourceVersion: summary.sourceVersion });
  });
  it("guards dirty switching and locks switching during a save; failure keeps the draft", async () => {
    let reject!: (error: Error) => void;
    mocks.upsertSummaryMaterial.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "保留草稿" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "写作卡片" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("摘要内容")).toHaveValue("保留草稿");
    fireEvent.click(screen.getByRole("button", { name: "保存摘要" }));
    await waitFor(() => expect(mocks.upsertSummaryMaterial).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "写作卡片" }));
    expect(screen.getByLabelText("摘要内容")).toBeDisabled();
    await act(async () => reject(new Error("写入失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByLabelText("摘要内容")).toHaveValue("保留草稿");
  });
  it("saves card ordering only on commit and validates empty numeric input", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "写作卡片" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "新建卡片" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建卡片" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "节奏" } });
    fireEvent.change(screen.getByLabelText("卡片内容"), { target: { value: "交替长短句" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "保存卡片" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "4" } });
    expect(mocks.upsertWritingCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存卡片" }));
    await waitFor(() => expect(mocks.upsertWritingCard).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 4 })));
  });
  it("enqueues real regeneration, follows failure, and permits another refresh", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    mocks.enqueueChapterSummaryRefresh.mockResolvedValue({ id: "job-1" });
    mocks.listJobs.mockResolvedValue([{ id: "job-1", status: "RUNNING" }]);
    const client = renderView(); await selectSummary();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(mocks.enqueueChapterSummaryRefresh).toHaveBeenCalledWith("chapter-1"));
    expect(mocks.rebuildSummaryMaterial).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "生成中…" })).toBeDisabled();
    mocks.listJobs.mockResolvedValue([{ id: "job-1", status: "FAILED", errorSummary: "后台生成失败" }]);
    await client.invalidateQueries({ queryKey: ["jobs"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("后台生成失败");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeEnabled();
  });
  it("refuses to save after the current project changes", async () => {
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "当前作品资料" } });
    mocks.getCurrentProject.mockResolvedValue({ projectId: "other-project" });
    fireEvent.click(screen.getByRole("button", { name: "保存摘要" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("作品已切换");
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
  });
});
