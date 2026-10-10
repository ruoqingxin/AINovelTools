import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityCard } from "../lib/tauri-client";
import { StoryBibleView } from "./story-bible-view";

const mocks = vi.hoisted(() => ({
  listEntityCards: vi.fn(),
  listEntityRevisions: vi.fn(),
  upsertEntity: vi.fn(),
  importEntities: vi.fn(),
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
function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><StoryBibleView /></QueryClientProvider>);
  return client;
}

describe("StoryBibleView", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertEntity.mockReset();
    mocks.importEntities.mockReset();
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

  it("opens the exact entity and reads histories only for the selected entity", async () => {
    window.history.replaceState(null, "", "/knowledge?entity=entity-1&targetProject=project-1&returnTo=%2Fwriting%3Fassistant%3Dplan%23chapter-1");
    mocks.listEntityCards.mockResolvedValue([card, { ...card, entity: { ...card.entity, id: "other-entity" } }]);
    mocks.listEntityRevisions.mockResolvedValue([{ ...card.revision, id: "obsolete", name: "错误旧名字" }]);
    renderView();
    expect(await screen.findByDisplayValue("沈砚")).toBeVisible();
    expect(screen.getByRole("link", { name: "返回来源" })).toHaveAttribute("href", "/writing?assistant=plan#chapter-1");
    expect(mocks.listEntityRevisions).toHaveBeenCalledWith("entity-1");
    expect(mocks.listEntityRevisions).not.toHaveBeenCalledWith("other-entity");
    expect(screen.getByDisplayValue("沈砚")).not.toHaveValue("错误旧名字");
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
    const input = await screen.findByDisplayValue("沈砚");
    fireEvent.change(input, { target: { value: "提交快照" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "保存期间的新编辑" } });
    const next = { entity: { ...card.entity, currentRevisionId: "revision-2", version: 2 },
      revision: { ...card.revision, id: "revision-2", name: "提交快照", revision: 2 } };
    mocks.listEntityCards.mockResolvedValue([next]);
    resolve(next.entity);
    await screen.findByText("已保存为新修订");
    expect(input).toHaveValue("保存期间的新编辑");
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "保存期间的新编辑", expectedVersion: 2, baseRevisionId: "revision-2",
    })));
  });

  it("renders the workspace controls and empty state", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoryBibleView />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "设定资料" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "章节审核" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索实体" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "实体类型筛选" })).toBeVisible();
    expect(await screen.findByText("没有符合条件的实体。")).toBeVisible();
  });

  it("reports a successful append-only save", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoryBibleView />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getAllByPlaceholderText("例如：林澈")[0], { target: { value: "林澈" } });
    const saveButton = screen.getAllByRole("button", { name: "创建实体" }).find((button) => !button.hasAttribute("disabled"));
    fireEvent.click(saveButton!);

    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenCalledWith(expect.objectContaining({ name: "林澈" })));
    expect(await screen.findByText("已保存为新修订")).toBeVisible();
  });

  async function prepareImport() {
    mocks.listModelProfiles.mockResolvedValue([{ id: "model", capability: "CHAT", hasSecret: true }]);
    mocks.extractEntitiesFromText.mockResolvedValue([
      { name: "候选甲", description: "描述甲", aliases: ["别名"], tags: ["标签"] },
      { name: "候选乙", description: "描述乙", aliases: [], tags: [] },
    ]);
    mocks.listEntityCards.mockResolvedValue([card]);
    renderView();
    fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "导入主题" } });
    fireEvent.change(screen.getByLabelText("简要概述"), { target: { value: "力量体系" } });
    fireEvent.change(screen.getByLabelText("适用范围"), { target: { value: "本书人物" } });
    const file = new File(["资料原文"], "资料.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve("资料原文") });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "按主题提炼" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "按主题提炼" }));
    await screen.findByDisplayValue("候选甲");
  }

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
    expect(screen.getByRole("button", { name: "创建实体" })).toBeDisabled();
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

  it("keeps candidates when switching entities or replacing the file is cancelled", async () => {
    await prepareImport();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /沈砚/ }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByDisplayValue("候选甲")).toBeVisible();
    const file = new File(["替换"], "新文件.md");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(screen.getByText("资料.md")).toBeVisible();
    expect(screen.getByDisplayValue("候选乙")).toBeVisible();
  });
});
