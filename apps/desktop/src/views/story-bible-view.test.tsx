import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityCard } from "../lib/tauri-client";
import { StoryBibleView } from "./story-bible-view";
import { AiWorkspaceContext } from "./content-identity";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
vi.mock("./knowledge-section-nav", () => ({ KnowledgeSectionNav: () => null }));

const mocks = vi.hoisted(() => ({
  listEntityCards: vi.fn(),
  listEntityRevisions: vi.fn(),
  upsertEntity: vi.fn(),
  importEntities: vi.fn(),
  previewEntityDeletion: vi.fn(),
  deleteEntities: vi.fn(),
  extractEntitiesFromText: vi.fn(),
  getCurrentProject: vi.fn(),
  listModelProfiles: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  getProjectAiTaskOverrides: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    listEntityCards: mocks.listEntityCards,
    listEntityRevisions: mocks.listEntityRevisions,
    upsertEntity: mocks.upsertEntity,
    importEntities: mocks.importEntities,
    previewEntityDeletion: mocks.previewEntityDeletion,
    deleteEntities: mocks.deleteEntities,
    extractEntitiesFromText: mocks.extractEntitiesFromText,
    getCurrentProject: mocks.getCurrentProject,
    listModelProfiles: mocks.listModelProfiles,
    getAiTaskPreferences: mocks.getAiTaskPreferences,
    getProjectAiTaskOverrides: mocks.getProjectAiTaskOverrides,
    setEntityArchived: vi.fn(),
  };
});
vi.mock("./entity-chapters", () => ({ EntityChapters: () => <p>关联章节</p> }));

const card: EntityCard = {
  entity: { id: "entity-1", projectId: "project-1", entityType: "CHARACTER", lifecycleStatus: "ACTIVE",
    currentRevisionId: "revision-1", version: 1, createdAt: "", updatedAt: "" },
  revision: { id: "revision-1", entityId: "entity-1", revision: 1, name: "沈砚", aliases: ["小沈"],
    description: "原描述", fixedAttributesJson: "{}", tags: [], sourceVersion: null, baseRevisionId: null, createdAt: "" },
};
function renderView(aiWorkspace = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AiWorkspaceContext.Provider value={aiWorkspace}><QueryClientProvider client={client}><ConfirmActionProvider><StoryBibleView /></ConfirmActionProvider></QueryClientProvider></AiWorkspaceContext.Provider>);
  return client;
}

describe("StoryBibleView", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertEntity.mockReset();
    mocks.importEntities.mockReset();
    mocks.extractEntitiesFromText.mockReset();
    mocks.previewEntityDeletion.mockReset();
    mocks.deleteEntities.mockReset();
    mocks.previewEntityDeletion.mockResolvedValue([{ id: "entity-1", name: "沈砚", blockers: [] }]);
    mocks.deleteEntities.mockResolvedValue(null);
    window.history.replaceState(null, "", "/knowledge");
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listModelProfiles.mockResolvedValue([]);
    mocks.getAiTaskPreferences.mockResolvedValue({});
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ available: true });
    mocks.listEntityCards.mockResolvedValue([]);
    mocks.listEntityRevisions.mockResolvedValue([]);
    mocks.upsertEntity.mockResolvedValue({
      id: "entity-1",
      projectId: "project-1",
      entityType: "CHARACTER",
      lifecycleStatus: "ACTIVE",
      currentRevisionId: "revision-1",
      version: 1,
      createdAt: "",
      updatedAt: "",
    });
  });

  it("keeps the normal setting page read-only and links the exact typed target to AI", async () => {
    window.history.replaceState(null, "", "/knowledge?entity=entity-1&targetProject=project-1");
    mocks.listEntityCards.mockResolvedValue([card]);
    const client = new QueryClient();
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={client}>
      <StoryBibleView />
    </QueryClientProvider></AiWorkspaceContext.Provider>);
    expect(await screen.findByRole("heading", { name: "沈砚" })).toBeVisible();
    expect(screen.getByText("设定 · 人物")).toBeVisible();
    expect(screen.queryByRole("button", { name: /新建实体|导入|编辑实体|讨论|删除|批量管理/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "资料" })).toBeVisible();
    const link = screen.getByRole("link", { name: "编辑设定" });
    expect(link).toHaveAttribute("href", "/discussion?work=entity&targetProject=project-1&entity=entity-1");
    expect(link).toHaveAttribute("title", "在共创中编辑当前设定");
    expect(link.querySelectorAll("svg")).toHaveLength(1);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    expect(mocks.extractEntitiesFromText).not.toHaveBeenCalled();
  });

  it("opens the exact entity and reads histories only for the selected entity", async () => {
    window.history.replaceState(null, "", "/knowledge?entity=entity-1&targetProject=project-1&returnTo=%2Fwriting%3Fassistant%3Dplan%23chapter-1");
    mocks.listEntityCards.mockResolvedValue([card, { ...card, entity: { ...card.entity, id: "other-entity" } }]);
    mocks.listEntityRevisions.mockResolvedValue([{ ...card.revision, id: "obsolete", name: "错误旧名字" }]);
    renderView(false);
    expect(await screen.findByRole("heading", { name: "沈砚" })).toBeVisible();
    expect(screen.getByRole("link", { name: "返回来源" })).toHaveAttribute("href", "/writing?assistant=plan#chapter-1");
    expect(mocks.listEntityRevisions).toHaveBeenCalledWith("entity-1");
    expect(mocks.listEntityRevisions).not.toHaveBeenCalledWith("other-entity");
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();
  });

  it("finds an entity by alias or description and resets an empty filter without changing it", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    const search = screen.getByLabelText("搜索实体");
    await screen.findByRole("button", { name: /沈砚/ });
    for (const query of ["小沈", "原描述"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByRole("button", { name: /沈砚/ })).toBeVisible();
    }
    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.queryByRole("button", { name: /沈砚/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: /沈砚/ })).toBeVisible();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  function mobileViewport() {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
  }

  it("keeps mobile list filters, scroll and selection when returning from a setting", async () => {
    mobileViewport();
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    const list = screen.getByRole("complementary", { name: "实体列表" });
    const workspace = document.querySelector(".story-bible-view")!.parentElement!;
    workspace.classList.add("workspace");
    expect(screen.queryByRole("region", { name: "设定详情" })).not.toBeInTheDocument();
    const item = await screen.findByRole("button", { name: /沈砚/ });
    fireEvent.change(screen.getByLabelText("搜索实体"), { target: { value: "小沈" } });
    fireEvent.change(screen.getByLabelText("实体类型筛选"), { target: { value: "CHARACTER" } });
    list.scrollTop = 145;
    workspace.scrollTop = 320;
    fireEvent.click(item);
    expect(list).not.toBeVisible();
    expect(screen.getByRole("region", { name: "设定详情" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "搜索实体" })).not.toBeInTheDocument();
    workspace.scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: "返回设定列表" }));
    expect(list).toBeVisible();
    expect(screen.getByLabelText("搜索实体")).toHaveValue("小沈");
    expect(screen.getByLabelText("实体类型筛选")).toHaveValue("CHARACTER");
    await waitFor(() => expect(item).toHaveFocus());
    expect(list.scrollTop).toBe(145);
    expect(workspace.scrollTop).toBe(320);
    fireEvent.click(item);
    expect(screen.getByRole("heading", { name: "沈砚" })).toBeVisible();
    expect(list).not.toBeVisible();
  });

  it("protects dirty mobile edits and restores formal content only after an approved return", async () => {
    mobileViewport();
    window.history.replaceState(null, "", "/discussion?work=entity&targetProject=project-1&entity=entity-1");
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "编辑实体" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "暂未保存的姓名" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "返回设定列表" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("名称")).toHaveValue("暂未保存的姓名");
    expect(screen.getByLabelText("名称")).toHaveFocus();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "返回设定列表" }));
    fireEvent.click(screen.getByRole("button", { name: /沈砚/ }));
    expect(await screen.findByRole("heading", { name: "沈砚" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "名称" })).not.toBeInTheDocument();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("opens mobile creation directly and returns to the list when an empty new form is cancelled", async () => {
    mobileViewport();
    window.history.replaceState(null, "", "/discussion?work=entity&targetProject=project-1&action=new");
    renderView();
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveFocus();
    expect(document.querySelector(".library-list")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("complementary", { name: "实体列表" })).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("搜索实体")).toHaveFocus());
    await waitFor(() => expect(screen.getByRole("button", { name: "新建实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    expect(screen.getByLabelText("名称")).toHaveFocus();
  });

  it("allows an invalid mobile setting target to return to the library without choosing another item", async () => {
    mobileViewport();
    window.history.replaceState(null, "", "/discussion?work=entity&targetProject=project-1&entity=missing");
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他实体");
    expect(document.querySelector(".library-list")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回设定列表" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /沈砚/ })).toBeVisible();
    expect(mocks.listEntityRevisions).not.toHaveBeenCalled();
  });

  it("locks the mobile back action during a save and retains the form on failure", async () => {
    mobileViewport();
    window.history.replaceState(null, "", "/discussion?work=entity&targetProject=project-1&action=new");
    let reject!: (cause: Error) => void;
    mocks.upsertEntity.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    renderView();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新设定" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "创建实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "创建实体" }));
    expect(screen.getByRole("button", { name: "返回设定列表" })).toBeDisabled();
    await act(async () => reject(new Error("保存失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByLabelText("名称")).toHaveValue("新设定");
    expect(screen.getByRole("button", { name: "返回设定列表" })).toBeEnabled();
  });

  it("keeps optional aliases and tags collapsed when creating an entity", async () => {
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    expect(screen.getByLabelText("名称")).toHaveFocus();
    expect(screen.getByLabelText("描述")).toBeVisible();
    expect(screen.getByLabelText("别名")).not.toBeVisible();
    fireEvent.click(screen.getByText("别名与标签"));
    expect(screen.getByLabelText("别名")).toBeVisible();
    fireEvent.change(screen.getByLabelText("别名"), { target: { value: "小沈" } });
    fireEvent.click(screen.getByText("别名与标签 · 已设置"));
    expect(screen.getByLabelText("别名")).toHaveValue("小沈");
  });

  it("retries loading the entity list without treating failure as an empty library", async () => {
    mocks.listEntityCards.mockRejectedValueOnce(new Error("实体读取失败"));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("实体读取失败");
    expect(screen.queryByText("暂无人物与世界设定")).not.toBeInTheDocument();
    mocks.listEntityCards.mockResolvedValue([card]);
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByRole("button", { name: /沈砚/ })).toBeVisible();
  });

  it.each(["?entity=missing&targetProject=project-1", "?entity=entity-1&targetProject=wrong", "?entity="])(
    "keeps invalid deep links explicit without opening another entity: %s", async (search) => {
      window.history.replaceState(null, "", `/knowledge${search}`);
      mocks.listEntityCards.mockResolvedValue([card]);
      renderView();
      expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他实体");
      expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "新建实体" })).not.toBeInTheDocument();
      expect(mocks.listEntityRevisions).not.toHaveBeenCalled();
    });

  it("preserves dirty edits across background revisions and reloads only after confirmation", async () => {
    window.history.replaceState(null, "", "/knowledge?entity=entity-1");
    mocks.listEntityCards.mockResolvedValue([card]);
    const client = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "编辑实体" }));
    const input = await screen.findByDisplayValue("沈砚");
    fireEvent.change(input, { target: { value: "本地修改" } });
    const next = { entity: { ...card.entity, version: 2, currentRevisionId: "revision-2" },
      revision: { ...card.revision, id: "revision-2", name: "远端新姓名", revision: 2 } };
    mocks.listEntityCards.mockResolvedValue([next]);
    await client.invalidateQueries({ queryKey: ["entity-cards"] });
    expect(await screen.findByText("实体已有新修订，本地修改仍保留。")).toBeVisible();
    expect(input).toHaveValue("本地修改");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "读取最新实体" }));
    expect(input).toHaveValue("本地修改");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "读取最新实体" }));
    await waitFor(() => expect(input).toHaveValue("远端新姓名"));
  });

  it("acknowledges a saved snapshot without replacing edits typed during the request", async () => {
    window.history.replaceState(null, "", "/knowledge?entity=entity-1");
    mocks.listEntityCards.mockResolvedValue([card]);
    let resolve!: (entity: EntityCard["entity"]) => void;
    mocks.upsertEntity.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "编辑实体" }));
    const input = await screen.findByDisplayValue("沈砚");
    fireEvent.change(input, { target: { value: "提交快照" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "保存期间的新编辑" } });
    const next = { entity: { ...card.entity, currentRevisionId: "revision-2", version: 2 },
      revision: { ...card.revision, id: "revision-2", name: "提交快照", revision: 2 } };
    mocks.listEntityCards.mockResolvedValue([next]);
    resolve(next.entity);
    await screen.findByText("上一版已保存，当前仍有未保存修改。");
    expect(input).toHaveValue("保存期间的新编辑");
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "保存期间的新编辑", expectedVersion: 2, baseRevisionId: "revision-2",
    })));
  });

  it("saves entity edits with the local shortcut and does not create unchanged revisions", async () => {
    window.history.replaceState(null, "", "/knowledge?entity=entity-1");
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "编辑实体" }));
    const input = screen.getByLabelText("名称");
    expect(screen.getByRole("button", { name: "保存为新修订" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "s", ctrlKey: true });
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  林舟  " } });
    fireEvent.keyDown(input, { key: "s", metaKey: true, isComposing: true });
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    const next = { ...card, entity: { ...card.entity, version: 2, currentRevisionId: "revision-2" },
      revision: { ...card.revision, id: "revision-2", revision: 2, name: "林舟" } };
    mocks.upsertEntity.mockResolvedValueOnce(next.entity);
    mocks.listEntityCards.mockResolvedValue([next]);
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    await screen.findByText("已保存为新修订");
    expect(input).toHaveValue("林舟");
    expect(screen.getByRole("button", { name: "保存为新修订" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "s", ctrlKey: true });
    expect(mocks.upsertEntity).toHaveBeenCalledTimes(1);
  });

  it("retains entity input when a shortcut save fails and permits retry", async () => {
    mocks.upsertEntity.mockRejectedValueOnce(new Error("保存失败"));
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    const name = screen.getByLabelText("名称");
    fireEvent.change(name, { target: { value: "林舟" } });
    fireEvent.keyDown(name, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(name).toHaveValue("林舟");
    expect(screen.getByRole("button", { name: "创建实体" })).toBeEnabled();
    fireEvent.keyDown(name, { key: "s", ctrlKey: true });
    await screen.findByText("已保存为新修订");
    expect(mocks.upsertEntity).toHaveBeenCalledTimes(2);
  });

  it("renders the workspace controls and empty state", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoryBibleView />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("heading", { name: "设定" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索实体" })).toBeVisible();
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "章节审核" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索实体" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "实体类型筛选" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "尚未添加人物与世界设定" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "实体列表" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加第一个设定" }));
    expect(screen.getByLabelText("名称")).toHaveFocus();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("reveals archived settings when resetting an empty active-only filter", async () => {
    mocks.listEntityCards.mockResolvedValue([{ ...card, entity: { ...card.entity, lifecycleStatus: "ARCHIVED" } }]);
    renderView();
    expect(await screen.findByRole("heading", { name: "没有符合条件的实体。" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(screen.getByLabelText("实体状态筛选")).toHaveValue("ALL");
    expect(screen.getByRole("button", { name: /沈砚/ })).toBeVisible();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("keeps the empty formal setting library read-only", async () => {
    renderView(false);
    expect(await screen.findByRole("link", { name: "添加第一个设定" })).toHaveAttribute("href",
      "/discussion?work=entity&targetProject=project-1&action=new");
    expect(screen.queryByRole("button", { name: "添加第一个设定" })).not.toBeInTheDocument();
  });

  it("reports a successful append-only save", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoryBibleView />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "新建实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    fireEvent.change(screen.getAllByPlaceholderText("例如：林澈")[0], { target: { value: "林澈" } });
    const saveButton = screen.getAllByRole("button", { name: "创建实体" }).find((button) => !button.hasAttribute("disabled"));
    fireEvent.click(saveButton!);

    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenCalledWith(expect.objectContaining({ name: "林澈" })));
    expect(await screen.findByText("已保存为新修订")).toBeVisible();
  });

  async function prepareImport(waitForCandidates = true) {
    mocks.listModelProfiles.mockResolvedValue([{ id: "model", capability: "CHAT", hasSecret: true }]);
    if (waitForCandidates) mocks.extractEntitiesFromText.mockResolvedValue([
      { name: "候选甲", description: "描述甲", aliases: ["别名"], tags: ["标签"] },
      { name: "候选乙", description: "描述乙", aliases: [], tags: [] },
    ]);
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "从文件导入" }));
    expect(screen.queryByLabelText("提炼主题")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("简要概述")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("适用范围")).not.toBeInTheDocument();
    expect(screen.getByLabelText("提炼要求（可选）")).toHaveValue("");
    const file = new File(["资料原文"], "资料.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve("资料原文") });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "提取实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "提取实体" }));
    if (waitForCandidates) await screen.findByDisplayValue("候选甲");
  }

  it("extracts a file without requiring a topic, summary or scope and keeps guidance optional", async () => {
    await prepareImport();
    expect(mocks.extractEntitiesFromText).toHaveBeenCalledWith({
      profileId: "model", entityType: "CHARACTER", sourceText: "资料原文", userGuidance: "",
      temperature: 0.1, maxOutputTokens: 4096,
    });
    expect(mocks.importEntities).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("提炼要求（可选）"), { target: { value: "  只整理主角  " } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "提取实体" }));
    await waitFor(() => expect(mocks.extractEntitiesFromText).toHaveBeenLastCalledWith(
      expect.objectContaining({ userGuidance: "只整理主角" })));
  });

  it("previews exact single deletion, defaults to cancellation and removes it only after confirmation", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /沈砚/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除实体" }));
    let dialog = await screen.findByRole("alertdialog", { name: "删除实体" });
    expect(dialog).toHaveTextContent("沈砚");
    expect(dialog).toHaveTextContent("全部修订历史");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(mocks.previewEntityDeletion).toHaveBeenCalledWith({
      expectedProjectId: "project-1", entities: [{ id: "entity-1", expectedVersion: 1 }],
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(mocks.deleteEntities).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "删除实体" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "删除实体" }));
    dialog = await screen.findByRole("alertdialog");
    mocks.listEntityCards.mockResolvedValue([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除 1 个实体" }));
    expect(await screen.findByText("已删除 1 个实体")).toBeVisible();
    expect(mocks.deleteEntities).toHaveBeenCalledWith(mocks.previewEntityDeletion.mock.calls[0][0]);
    expect(screen.queryByRole("heading", { name: "沈砚" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "尚未添加人物与世界设定" })).toBeVisible();
  });

  const secondCard: EntityCard = { entity: { ...card.entity, id: "entity-2", version: 4, currentRevisionId: "revision-2" },
    revision: { ...card.revision, id: "revision-2", entityId: "entity-2", name: "林舟" } };

  it("deletes the selected batch in one request and locks selection while writing", async () => {
    mocks.listEntityCards.mockResolvedValue([card, secondCard]);
    mocks.previewEntityDeletion.mockResolvedValue([
      { id: card.entity.id, name: "沈砚", blockers: [] },
      { id: secondCard.entity.id, name: "林舟", blockers: [] },
    ]);
    let resolve!: () => void;
    mocks.deleteEntities.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "批量管理实体" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前实体" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    const dialog = await screen.findByRole("alertdialog", { name: "批量删除实体" });
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除 2 个实体" }));
    await waitFor(() => expect(mocks.deleteEntities).toHaveBeenCalledTimes(1));
    expect(mocks.deleteEntities).toHaveBeenCalledWith({ expectedProjectId: "project-1",
      entities: [{ id: "entity-1", expectedVersion: 1 }, { id: "entity-2", expectedVersion: 4 }] });
    expect(screen.getByRole("checkbox", { name: "选择实体：沈砚" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "退出批量管理" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建实体" })).toBeDisabled();
    mocks.listEntityCards.mockResolvedValue([]);
    await act(async () => resolve());
    expect(await screen.findByText("已删除 2 个实体")).toBeVisible();
  });

  it("clears batch selection on filtering so hidden items cannot be accidentally deleted", async () => {
    mocks.listEntityCards.mockResolvedValue([card, secondCard]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "批量管理实体" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择实体：沈砚" }));
    expect(screen.getByRole("checkbox", { name: "全选当前实体" })).toBePartiallyChecked();
    fireEvent.change(screen.getByLabelText("搜索实体"), { target: { value: "林舟" } });
    expect(screen.getByRole("button", { name: "删除所选" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择实体：林舟" })).not.toBeChecked();
    expect(mocks.previewEntityDeletion).not.toHaveBeenCalled();
  });

  it("explains references and leaves the entire selection intact without offering deletion", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    mocks.previewEntityDeletion.mockResolvedValue([{ id: "entity-1", name: "沈砚", blockers: ["章节关联", "共创发布记录"] }]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "批量管理实体" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前实体" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("沈砚（章节关联、共创发布记录）");
    expect(screen.getByRole("alert")).toHaveTextContent("改用归档");
    expect(screen.getByRole("checkbox", { name: "选择实体：沈砚" })).toBeChecked();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.deleteEntities).not.toHaveBeenCalled();
  });

  it("preserves selection on deletion failure and retries only after another explicit confirmation", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    mocks.deleteEntities.mockRejectedValueOnce(new Error("删除失败"));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "批量管理实体" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前实体" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "永久删除 1 个实体" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("删除失败");
    expect(screen.getByRole("checkbox", { name: "选择实体：沈砚" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(mocks.deleteEntities).toHaveBeenCalledTimes(1);
    mocks.listEntityCards.mockResolvedValue([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除 1 个实体" }));
    await screen.findByText("已删除 1 个实体");
    expect(mocks.deleteEntities.mock.calls[1]).toEqual(mocks.deleteEntities.mock.calls[0]);
  });

  it("rejects stale batch snapshots instead of silently deleting the latest revision", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    mocks.previewEntityDeletion.mockRejectedValueOnce({ code: "VERSION_CONFLICT", message: "conflict" });
    const client = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "批量管理实体" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前实体" }));
    mocks.listEntityCards.mockResolvedValue([{ ...card, entity: { ...card.entity, version: 2 } }]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["entity-cards"] }); });
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("列表已刷新");
    expect(mocks.previewEntityDeletion).toHaveBeenCalledWith(expect.objectContaining({
      entities: [{ id: "entity-1", expectedVersion: 1 }],
    }));
    expect(mocks.deleteEntities).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "删除所选" })).toBeDisabled();
  });

  it("does not submit an old confirmation after the current project changes", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    const client = renderView();
    fireEvent.click(await screen.findByRole("button", { name: /沈砚/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除实体" }));
    const dialog = await screen.findByRole("alertdialog");
    act(() => client.setQueryData(["current-project"], { projectId: "other-project" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除 1 个实体" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前项目已切换");
    expect(mocks.deleteEntities).not.toHaveBeenCalled();
  });

  it("preserves entities when a new reference blocks deletion after the confirmation preview", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    mocks.deleteEntities.mockRejectedValueOnce({ code: "ENTITY_REFERENCED", message: "实体已有章节关联，请改用归档。" });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /沈砚/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除实体" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "永久删除 1 个实体" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请改用归档");
    expect(screen.getByRole("heading", { name: "沈砚" })).toBeVisible();
    expect(screen.getByRole("button", { name: "归档实体" })).toBeEnabled();
  });

  it("lets extraction continue in a collapsed non-modal panel while editing an entity", async () => {
    let resolve!: (items: Array<{ name: string; description: string; aliases: string[]; tags: string[] }>) => void;
    mocks.extractEntitiesFromText.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await prepareImport(false);
    expect(screen.getByRole("dialog", { name: "从文件导入" })).toHaveAttribute("aria-modal", "false");
    expect(screen.getByRole("button", { name: "放弃本次导入" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "收起文件导入" }));
    expect(screen.queryByRole("dialog", { name: "从文件导入" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看导入进度" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /沈砚/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑实体" }));
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "编辑中的实体" } });
    expect(screen.getByRole("button", { name: "保存为新修订" })).toBeEnabled();
    await act(async () => resolve([{ name: "后台候选", description: "后台提炼描述", aliases: [], tags: [] }]));
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("编辑中的实体");
    expect(mocks.importEntities).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "审核导入候选（1）" }));
    expect(screen.getByDisplayValue("后台候选")).toBeVisible();
    expect(screen.getByText("资料.md")).toBeVisible();
    expect(mocks.extractEntitiesFromText).toHaveBeenCalledTimes(1);
  });

  it("keeps extraction errors separate from edits and shows them when the panel reopens", async () => {
    let reject!: (cause: Error) => void;
    mocks.extractEntitiesFromText.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await prepareImport(false);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "本地新设定" } });
    await act(async () => reject(new Error("网络连接中断")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("本地新设定");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "查看提炼失败" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("本地新设定");
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "查看提炼失败" }));
    expect(screen.getByRole("alert")).toHaveTextContent("网络连接中断");
    expect(screen.getByRole("button", { name: "重试提炼" })).toBeEnabled();
  });

  it("supports selecting and deselecting individual candidates and preserves skipped items after writing", async () => {
    mocks.importEntities.mockResolvedValueOnce([card.entity]);
    await prepareImport();
    const selectAll = screen.getByRole("checkbox", { name: "全选候选" });
    fireEvent.click(selectAll);
    expect(screen.getByRole("button", { name: "确认写入 0 条" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /选择第 1 条候选/ }));
    expect(selectAll).toBePartiallyChecked();
    fireEvent.change(screen.getByDisplayValue("候选甲"), { target: { value: "  选中的候选  " } });
    fireEvent.click(screen.getByRole("button", { name: "确认写入 1 条" }));
    await screen.findByText("已从“资料.md”导入 1 条人物信息");
    expect(mocks.importEntities).toHaveBeenCalledWith({ expectedProjectId: "project-1",
      items: [expect.objectContaining({ name: "选中的候选", aliases: ["别名"], tags: ["标签"] })] });
    expect(mocks.importEntities.mock.calls[0][0].items[0]).not.toHaveProperty("selected");
    expect(screen.queryByDisplayValue("  选中的候选  ")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("候选乙")).toBeVisible();
    expect(screen.getByText("资料.md")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认写入 0 条" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "全选候选" }));
    expect(screen.getByRole("button", { name: "确认写入 1 条" })).toBeEnabled();
  });

  it("does not submit a selected candidate with an empty name and retains it when deselected", async () => {
    await prepareImport();
    fireEvent.change(screen.getByDisplayValue("候选甲"), { target: { value: " " } });
    expect(screen.getByRole("button", { name: "确认写入 2 条" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /选择第 1 条候选/ }));
    expect(screen.getByRole("button", { name: "确认写入 1 条" })).toBeEnabled();
    expect(mocks.importEntities).not.toHaveBeenCalled();
  });

  it("retains the selected subset and skipped edits when a write fails", async () => {
    mocks.importEntities.mockRejectedValueOnce(new Error("写入失败"));
    await prepareImport();
    fireEvent.click(screen.getByRole("checkbox", { name: /选择第 2 条候选/ }));
    fireEvent.change(screen.getByDisplayValue("描述乙"), { target: { value: "保留未选条目的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "确认写入 1 条" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByRole("checkbox", { name: /选择第 1 条候选/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /选择第 2 条候选/ })).not.toBeChecked();
    expect(screen.getByDisplayValue("保留未选条目的修改")).toBeVisible();
    expect(screen.getByText("资料.md")).toBeVisible();
    mocks.importEntities.mockResolvedValueOnce([card.entity]);
    fireEvent.click(screen.getByRole("button", { name: "确认写入 1 条" }));
    await screen.findByText("已从“资料.md”导入 1 条人物信息");
    expect(mocks.importEntities.mock.calls[1]).toEqual(mocks.importEntities.mock.calls[0]);
    expect(screen.getByDisplayValue("保留未选条目的修改")).toBeVisible();
  });

  it("submits a single project-scoped batch and locks edits, file changes and entity selection", async () => {
    let resolve!: (entities: EntityCard["entity"][]) => void;
    mocks.importEntities.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await prepareImport();
    fireEvent.change(screen.getByDisplayValue("候选甲"), { target: { value: "作者修改甲" } });
    const button = screen.getByRole("button", { name: "确认写入 2 条" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.importEntities).toHaveBeenCalledTimes(1));
    expect(mocks.importEntities).toHaveBeenCalledWith({ expectedProjectId: "project-1", items: [
      expect.objectContaining({ name: "作者修改甲", entityType: "CHARACTER", sourceVersion: "资料.md", aliases: ["别名"], tags: ["标签"] }),
      expect.objectContaining({ name: "候选乙", description: "描述乙" }),
    ] });
    expect(screen.getByDisplayValue("作者修改甲")).toBeDisabled();
    expect(document.querySelector('input[type="file"]')).toBeDisabled();
    expect(screen.getByRole("button", { name: /沈砚/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建实体" })).toBeDisabled();
    await act(async () => { resolve([card.entity, { ...card.entity, id: "entity-2" }]); });
    expect(await screen.findByText("已从“资料.md”导入 2 条人物信息")).toBeVisible();
    expect(screen.queryByDisplayValue("作者修改甲")).not.toBeInTheDocument();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("keeps the full edited batch and file on failure and retries with the same snapshot", async () => {
    mocks.importEntities.mockRejectedValueOnce(new Error("整批写入失败"));
    await prepareImport();
    fireEvent.change(screen.getByDisplayValue("描述乙"), { target: { value: "作者描述乙" } });
    fireEvent.click(screen.getByRole("button", { name: "确认写入 2 条" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("整批写入失败");
    expect(screen.getByDisplayValue("候选甲")).toBeEnabled();
    expect(screen.getByDisplayValue("作者描述乙")).toBeVisible();
    expect(screen.getByText("资料.md")).toBeVisible();
    mocks.importEntities.mockResolvedValueOnce([card.entity, card.entity]);
    fireEvent.click(screen.getByRole("button", { name: "确认写入 2 条" }));
    await screen.findByText("已从“资料.md”导入 2 条人物信息");
    expect(mocks.importEntities.mock.calls[1]).toEqual(mocks.importEntities.mock.calls[0]);
  });

  it("retains candidates when switching entities and still protects them from file replacement or discard", async () => {
    await prepareImport();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /沈砚/ }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "沈砚" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "审核导入候选（2）" }));
    expect(screen.getByDisplayValue("候选甲")).toBeVisible();
    const file = new File(["替换"], "新文件.md");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(screen.getByText("资料.md")).toBeVisible();
    expect(screen.getByDisplayValue("候选乙")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "放弃本次导入" }));
    expect(screen.getByDisplayValue("候选甲")).toBeVisible();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "放弃本次导入" }));
    fireEvent.click(screen.getByRole("button", { name: "从文件导入" }));
    expect(screen.queryByDisplayValue("候选甲")).not.toBeInTheDocument();
    expect(screen.queryByText("资料.md")).not.toBeInTheDocument();
  });
  it("uses correct alias/tag fields and restores the saved detail after cancellation", async () => {
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /沈砚/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑实体" }));
    expect(screen.getByLabelText("别名")).toHaveValue("小沈");
    expect(screen.queryByLabelText("简要概述")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "未保存姓名" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("heading", { name: "沈砚" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "未保存姓名" })).not.toBeInTheDocument();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });
});
