import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialsView } from "./materials-view";
import { AiWorkspaceContext } from "./content-identity";
vi.mock("./knowledge-section-nav", () => ({ KnowledgeSectionNav: () => null }));

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
  it("shows reference content outside AI without edit, adoption or generation controls", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    const client = new QueryClient();
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={client}>
      <MaterialsView />
    </QueryClientProvider></AiWorkspaceContext.Provider>);
    await selectSummary();
    expect(screen.getByText("辅助参考 · 章节记忆")).toBeVisible();
    expect(screen.queryByRole("button", { name: /新建参考摘要|编辑参考副本|重新生成|确认为有效/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "资料" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "处理参考" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "处理参考" })).toHaveAttribute("href",
      "/discussion?work=materials&targetProject=project-1&summary=summary-1&materialKind=SUMMARY");
    expect(screen.queryByRole("link", { name: /去共创更新/ })).not.toBeInTheDocument();
    expect(mocks.listJobs).not.toHaveBeenCalled();
    expect(mocks.rebuildSummaryMaterial).not.toHaveBeenCalled();
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
  });
  it("starts in list/detail mode and opens only the requested creation form", async () => {
    renderView();
    expect(screen.queryByRole("heading", { name: "辅助参考" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "参考资料类型" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "摘要内容" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    expect(screen.getByLabelText("摘要内容")).toHaveFocus();
    expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存摘要" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "作者参考" } });
    fireEvent.click(screen.getByRole("button", { name: "保存摘要" }));
    await waitFor(() => expect(mocks.upsertSummaryMaterial).toHaveBeenCalledWith(expect.objectContaining({
      content: "作者参考", generationMode: "MANUAL_REFERENCE", precision: "L0", lifecycleStatus: "ACTIVE",
    })));
  });
  it("uses a single empty surface and opens the selected material kind without writing", async () => {
    renderView();
    expect(await screen.findByRole("heading", { name: "尚未添加摘要与记忆" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "参考资料列表" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "写作卡片" }));
    expect(await screen.findByRole("heading", { name: "尚未添加写作卡片" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "添加写作卡片" }));
    expect(screen.getByRole("heading", { name: "新建卡片" })).toBeVisible();
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
    expect(mocks.upsertWritingCard).not.toHaveBeenCalled();
  });
  it("recovers a full-width search empty state without selecting a different material", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    renderView();
    await screen.findByRole("button", { name: /章节记忆正文/ });
    fireEvent.change(screen.getByLabelText("搜索参考资料"), { target: { value: "无匹配" } });
    expect(screen.getByRole("heading", { name: "没有匹配资料" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: /章节记忆正文/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "选择一条参考资料" })).toBeVisible();
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
  });
  it("clears a no-match search without discarding an unsaved material", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    renderView();
    await screen.findByRole("button", { name: /章节记忆正文/ });
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "正在整理的新笔记" } });
    fireEvent.change(screen.getByLabelText("搜索参考资料"), { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配资料")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByLabelText("摘要内容")).toHaveValue("正在整理的新笔记");
    expect(screen.getByRole("button", { name: /章节记忆正文/ })).toBeVisible();
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
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
      expect(screen.queryByRole("group", { name: "参考资料类型" })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "搜索参考资料" })).not.toBeInTheDocument();
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
      expect(screen.getByRole("group", { name: "参考资料类型" })).toBeVisible();
      expect(screen.getByLabelText("搜索参考资料")).toHaveValue("章节记忆");
      await waitFor(() => expect(list.scrollTop).toBe(145));
      await selectSummary();
      expect(list).not.toBeVisible();
      expect(screen.getByRole("heading", { name: "章节记忆" })).toBeVisible();
    } finally { media.mockRestore(); }
  });
  it("keeps focus on the new material input on narrow screens", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    expect(screen.getByLabelText("摘要内容")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "写作卡片" }));
    fireEvent.click(screen.getByRole("button", { name: "新建卡片" }));
    expect(screen.getByLabelText("标题")).toHaveFocus();
  });
  it("opens the requested new reference form directly on mobile", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    window.history.replaceState(null, "", "/discussion?work=materials&targetProject=project-1&action=new");
    renderView();
    expect(await screen.findByRole("textbox", { name: "摘要内容" })).toBeVisible();
    expect(document.querySelector(".library-list")).not.toBeVisible();
    expect(document.querySelector(".library-detail")).toBeVisible();
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
    expect(await screen.findByText("参考副本已保存，原摘要未改动。")).toBeVisible();
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
    expect(screen.getByLabelText("标题")).toHaveFocus();
    expect(screen.getByLabelText("排序")).not.toBeVisible();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "节奏" } });
    fireEvent.change(screen.getByLabelText("卡片内容"), { target: { value: "交替长短句" } });
    fireEvent.click(screen.getByText("高级信息"));
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent("排序需填写有效整数");
    expect(screen.getByRole("button", { name: "保存卡片" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "4" } });
    expect(mocks.upsertWritingCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存卡片" }));
    await waitFor(() => expect(mocks.upsertWritingCard).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 4 })));
  });
  it("saves only the current material with the shortcut and ignores IME composition", async () => {
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建参考摘要" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建参考摘要" }));
    const content = screen.getByLabelText("摘要内容");
    fireEvent.keyDown(content, { key: "s", ctrlKey: true });
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
    fireEvent.change(content, { target: { value: "待保存的摘要" } });
    expect(screen.getByText("有未保存修改")).toBeVisible();
    fireEvent.keyDown(content, { key: "s", ctrlKey: true, isComposing: true });
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
    fireEvent.keyDown(content, { key: "s", ctrlKey: true });
    await waitFor(() => expect(mocks.upsertSummaryMaterial).toHaveBeenCalledTimes(1));
    expect(mocks.upsertWritingCard).not.toHaveBeenCalled();
  });
  it("keeps the current material editor when its selected list item is clicked again", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    renderView(); await selectSummary();
    fireEvent.click(screen.getByRole("button", { name: "编辑参考副本" }));
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "尚未保存的副本" } });
    const confirm = vi.spyOn(window, "confirm");
    await selectSummary();
    expect(screen.getByLabelText("摘要内容")).toHaveValue("尚未保存的副本");
    expect(confirm).not.toHaveBeenCalled();
  });
  it("does not save an unchanged manual reference", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([{ ...summary, generationMode: "MANUAL_REFERENCE" }]);
    renderView(); await selectSummary();
    fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
    expect(screen.getByRole("button", { name: "保存摘要" })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("摘要内容"), { key: "s", metaKey: true });
    expect(mocks.upsertSummaryMaterial).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("摘要内容"), { target: { value: "修改后" } });
    expect(screen.getByRole("button", { name: "保存摘要" })).toBeEnabled();
  });
  it("permits an unchanged automatic summary to be saved as a separate manual copy", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([summary]);
    renderView(); await selectSummary();
    fireEvent.click(screen.getByRole("button", { name: "编辑参考副本" }));
    expect(screen.getByRole("button", { name: "另存为参考摘要" })).toBeEnabled();
    fireEvent.keyDown(screen.getByLabelText("摘要内容"), { key: "s", metaKey: true });
    await waitFor(() => expect(mocks.upsertSummaryMaterial).toHaveBeenCalledWith(expect.objectContaining({
      generationMode: "MANUAL_REFERENCE", content: summary.content,
    })));
    expect(mocks.upsertSummaryMaterial.mock.calls[0][0].id).not.toBe(summary.id);
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
