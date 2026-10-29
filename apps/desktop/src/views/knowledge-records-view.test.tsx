import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeRecordsView } from "./knowledge-records-view";
import { AiWorkspaceContext } from "./content-identity";
vi.mock("./knowledge-section-nav", () => ({ KnowledgeSectionNav: () => null }));

const mocks = vi.hoisted(() => ({
  createRelation: vi.fn(),
  getCurrentProject: vi.fn(),
  listBeliefs: vi.fn(),
  listCurrentFacts: vi.fn(),
  listEvents: vi.fn(),
  listEvidenceAnchors: vi.fn(),
  listForeshadowings: vi.fn(),
  listPlanNodes: vi.fn(),
  listRelations: vi.fn(),
  updateRelation: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, ...mocks };
});

describe("KnowledgeRecordsView", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/knowledge/records");
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1", formatVersion: 1, name: "测试项目", createdAt: "" });
    mocks.listCurrentFacts.mockResolvedValue([
      { knowledgeId: "fact-1", subject: "林澈", predicate: "师从", object: "沈舟" },
      { knowledgeId: "fact-2", subject: "沈舟", predicate: "居于", object: "北境" },
    ]);
    mocks.listEvidenceAnchors.mockResolvedValue([{ id: "anchor-1", chapterId: "chapter-1", blockId: "block-1" }]);
    mocks.listPlanNodes.mockResolvedValue([]);
    mocks.listRelations.mockResolvedValue([]);
    mocks.listEvents.mockResolvedValue([]);
    mocks.listBeliefs.mockResolvedValue([]);
    mocks.listForeshadowings.mockResolvedValue([]);
    mocks.createRelation.mockResolvedValue({});
    mocks.updateRelation.mockResolvedValue({});
  });

  it("shows record type and evidence without edit controls outside AI", async () => {
    mocks.listRelations.mockResolvedValue([{
      id: "relation-1", projectId: "project-1", relationVersion: 1,
      fromKnowledgeId: "fact-1", toKnowledgeId: "fact-2", relationType: "同盟",
      evidenceAnchorIds: ["anchor-1"], lifecycleStatus: "ACTIVE",
    }]);
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={new QueryClient()}>
      <KnowledgeRecordsView />
    </QueryClientProvider></AiWorkspaceContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    expect(screen.getByText("剧情记录 · 关系")).toBeVisible();
    expect(screen.queryByRole("button", { name: /新建记录|编辑记录/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "资料" })).toBeVisible();
    expect(screen.getByRole("link", { name: "编辑记录" })).toHaveAttribute("href",
      "/discussion?work=records&targetProject=project-1&objectId=relation-1&tab=relations");
    expect(mocks.createRelation).not.toHaveBeenCalled();
    expect(mocks.updateRelation).not.toHaveBeenCalled();
  });

  it("does not fall back to another record for a missing exact target", async () => {
    window.history.replaceState(null, "", "/discussion?work=records&targetProject=project-1&tab=events&objectId=missing");
    mocks.listEvents.mockResolvedValue([{ id: "other", name: "另一事件", occurredAt: "", evidenceAnchorIds: [], eventVersion: 1, lifecycleStatus: "ACTIVE" }]);
    render(<QueryClientProvider client={new QueryClient()}><KnowledgeRecordsView /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他记录");
    expect(screen.queryByRole("button", { name: "编辑记录" })).not.toBeInTheDocument();
  });
  it("opens the current record type from the single empty surface without creating data", async () => {
    render(<QueryClientProvider client={new QueryClient()}><KnowledgeRecordsView /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "暂无关系记录" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "剧情记录列表" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加关系记录" }));
    expect(screen.getByRole("heading", { name: "新建关系记录" })).toBeVisible();
    expect(screen.getByRole("button", { name: "创建关系" })).toBeDisabled();
    expect(mocks.createRelation).not.toHaveBeenCalled();
  });
  it("resets an empty status filter while leaving the collection unselected", async () => {
    mocks.listRelations.mockResolvedValue([{
      id: "relation-1", projectId: "project-1", relationVersion: 1,
      fromKnowledgeId: "fact-1", toKnowledgeId: "fact-2", relationType: "同盟",
      evidenceAnchorIds: ["anchor-1"], lifecycleStatus: "ACTIVE",
    }]);
    render(<QueryClientProvider client={new QueryClient()}><KnowledgeRecordsView /></QueryClientProvider>);
    await screen.findByRole("button", { name: /同盟/ });
    fireEvent.change(screen.getByLabelText("审核状态筛选"), { target: { value: "ARCHIVED" } });
    expect(screen.getByRole("heading", { name: "没有符合条件的记录。" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(screen.getByRole("button", { name: /同盟/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "选择一条剧情记录" })).toBeVisible();
    expect(mocks.createRelation).not.toHaveBeenCalled();
  });

  it("creates a relation from current facts and an evidence anchor", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KnowledgeRecordsView />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "新建记录" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建记录" }));
    const evidence = await screen.findByRole("checkbox", { name: "未命名章节 · 证据 1" });
    fireEvent.change(screen.getByLabelText("起点事实"), { target: { value: "fact-1" } });
    fireEvent.change(screen.getByLabelText("终点事实"), { target: { value: "fact-2" } });
    fireEvent.change(screen.getByPlaceholderText("例如：师徒、敌对、隶属"), { target: { value: "师徒" } });
    fireEvent.click(evidence);
    fireEvent.click(screen.getByRole("button", { name: "创建关系" }));

    await waitFor(() => expect(mocks.createRelation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      fromKnowledgeId: "fact-1",
      toKnowledgeId: "fact-2",
      relationType: "师徒",
      evidenceAnchorIds: ["anchor-1"],
    })));
    expect(await screen.findByRole("status")).toHaveTextContent("已创建关系记录");
  });

  it("appends an edited relation as the next version", async () => {
    mocks.listRelations.mockResolvedValue([{
      id: "relation-1", projectId: "project-1", relationVersion: 1,
      fromKnowledgeId: "fact-1", toKnowledgeId: "fact-2", relationType: "同盟",
      evidenceAnchorIds: ["anchor-1"], lifecycleStatus: "ACTIVE", createdBy: "desktop-user",
      createdAt: "", updatedAt: "",
    }]);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <KnowledgeRecordsView />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    const relationTypeInputs = screen.getAllByPlaceholderText("例如：师徒、敌对、隶属");
    fireEvent.change(relationTypeInputs[relationTypeInputs.length - 1]!, { target: { value: "师徒" } });
    fireEvent.change(screen.getByLabelText("审核状态"), { target: { value: "NEEDS_REVIEW" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为 v2" }));

    await waitFor(() => expect(mocks.updateRelation).toHaveBeenCalledWith(expect.objectContaining({
      id: "relation-1",
      relationVersion: 2,
      relationType: "师徒",
      lifecycleStatus: "NEEDS_REVIEW",
    }), 1));
    expect(await screen.findByText("已追加为 v2")).toBeVisible();
  });

  const existing = {
    id: "relation-1", projectId: "project-1", relationVersion: 1,
    fromKnowledgeId: "fact-1", toKnowledgeId: "fact-2", relationType: "同盟",
    evidenceAnchorIds: ["anchor-1"], lifecycleStatus: "ACTIVE", createdBy: "desktop-user",
    createdAt: "", updatedAt: "",
  };
  function renderRecords() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><KnowledgeRecordsView /></QueryClientProvider>);
    return client;
  }
  function mobileViewport() {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
  }
  it("shows only one mobile pane and restores record filters, scroll and focus on return", async () => {
    mobileViewport();
    mocks.listRelations.mockResolvedValue([existing]);
    renderRecords();
    const list = screen.getByRole("complementary", { name: "剧情记录列表" });
    expect(screen.queryByRole("region", { name: "剧情记录详情" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索剧情记录"), { target: { value: "同盟" } });
    list.scrollTop = 120;
    const item = await screen.findByRole("button", { name: /同盟/ });
    fireEvent.click(item);
    expect(list).not.toBeVisible();
    expect(screen.getByRole("region", { name: "剧情记录详情" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "搜索剧情记录" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回记录列表" }));
    expect(list).toBeVisible();
    expect(screen.getByLabelText("搜索剧情记录")).toHaveValue("同盟");
    await waitFor(() => expect(item).toHaveFocus());
    expect(list.scrollTop).toBe(120);
    fireEvent.click(item);
    expect(screen.getByRole("heading", { name: "同盟" })).toBeVisible();
  });
  it("guards a mobile back action and does not leave while a record save is pending", async () => {
    mobileViewport();
    mocks.listRelations.mockResolvedValue([existing]);
    let finish!: (value: unknown) => void;
    mocks.updateRelation.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderRecords();
    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    fireEvent.change(screen.getByLabelText("关系类型"), { target: { value: "新同盟" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "返回记录列表" }));
    expect(screen.getByLabelText("关系类型")).toHaveValue("新同盟");
    expect(confirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "保存为 v2" }));
    await waitFor(() => expect(mocks.updateRelation).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "返回记录列表" })).toBeDisabled();
    await act(async () => finish({}));
    expect(await screen.findByRole("complementary", { name: "剧情记录列表" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("已追加为 v2");
  });
  it("allows a missing exact mobile target to return without selecting another record", async () => {
    mobileViewport();
    window.history.replaceState(null, "", "/discussion?work=records&targetProject=project-1&objectId=missing");
    mocks.listRelations.mockResolvedValue([existing]);
    renderRecords();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他记录");
    fireEvent.click(screen.getByRole("button", { name: "返回记录列表" }));
    expect(screen.getByRole("button", { name: /同盟/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "编辑记录" })).not.toBeInTheDocument();
  });
  it("resets filtered empty records without discarding an edited draft", async () => {
    mocks.listRelations.mockResolvedValue([existing]);
    renderRecords();
    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    fireEvent.change(screen.getByLabelText("关系类型"), { target: { value: "正在修改" } });
    fireEvent.change(screen.getByLabelText("搜索剧情记录"), { target: { value: "不存在" } });
    fireEvent.change(screen.getByLabelText("审核状态筛选"), { target: { value: "ARCHIVED" } });
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(screen.getByLabelText("搜索剧情记录")).toHaveValue("");
    expect(screen.getByLabelText("审核状态筛选")).toHaveValue("ALL");
    expect(screen.getByLabelText("关系类型")).toHaveValue("正在修改");
    expect(screen.getByRole("button", { name: /同盟/ })).toBeVisible();
    expect(mocks.updateRelation).not.toHaveBeenCalled();
  });
  it("shows a load failure without also claiming there are no records and retries in place", async () => {
    mocks.listRelations.mockRejectedValueOnce(new Error("记录读取失败"));
    renderRecords();
    expect(await screen.findByRole("alert")).toHaveTextContent("记录读取失败");
    expect(screen.queryByText("暂无关系记录")).not.toBeInTheDocument();
    expect(screen.queryByText("选择一条剧情记录")).not.toBeInTheDocument();
    mocks.listRelations.mockResolvedValue([existing]);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: /同盟/ })).toBeVisible();
  });
  it("does not treat a clean loaded record as dirty and guards actual edits", async () => {
    mocks.listRelations.mockResolvedValue([existing]);
    renderRecords();
    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    fireEvent.change(screen.getByLabelText("关系类型"), { target: { value: "本地修改" } });
    fireEvent.change(screen.getByLabelText("记录类型"), { target: { value: "events" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("记录类型")).toHaveValue("relations");
    expect(screen.getByLabelText("关系类型")).toHaveValue("本地修改");
    fireEvent.click(screen.getByRole("button", { name: "新建记录" }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("uses the captured edit version after a background change and keeps failed edits", async () => {
    mocks.listRelations.mockResolvedValue([existing]);
    mocks.updateRelation.mockRejectedValueOnce(new Error("VERSION_CONFLICT"));
    const client = renderRecords();
    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    fireEvent.change(screen.getByLabelText("关系类型"), { target: { value: "本地修改" } });
    mocks.listRelations.mockResolvedValue([{ ...existing, relationVersion: 2, relationType: "远端修订" }]);
    await client.invalidateQueries({ queryKey: ["relations"] });
    expect(await screen.findByText(/记录已有新版本/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "保存为 v2" }));
    await waitFor(() => expect(mocks.updateRelation).toHaveBeenCalledWith(expect.objectContaining({
      relationVersion: 2, relationType: "本地修改",
    }), 1));
    expect(await screen.findByRole("alert")).toHaveTextContent("VERSION_CONFLICT");
    expect(screen.getByLabelText("关系类型")).toHaveValue("本地修改");
  });
  it("locks all editing and switching while saving and links exact evidence", async () => {
    mocks.listRelations.mockResolvedValue([existing]);
    mocks.listPlanNodes.mockResolvedValue([{ id: "chapter-1", kind: "CHAPTER", title: "入城" }]);
    let resolve!: (value: unknown) => void;
    mocks.updateRelation.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    renderRecords();
    fireEvent.click(await screen.findByRole("button", { name: /同盟/ }));
    const source = new URL(screen.getByRole("link", { name: "入城 · 查看来源证据" }).getAttribute("href")!, window.location.origin);
    expect(source.searchParams.get("sourceEvidence")).toBe("anchor-1");
    expect(source.searchParams.get("sourceProject")).toBe("project-1");
    fireEvent.click(screen.getByRole("button", { name: "编辑记录" }));
    fireEvent.click(screen.getByRole("button", { name: "保存为 v2" }));
    await waitFor(() => expect(mocks.updateRelation).toHaveBeenCalled());
    expect(screen.getByLabelText("关系类型")).toBeDisabled();
    expect(screen.getByLabelText("记录类型")).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建记录" })).toBeDisabled();
    await act(async () => resolve({}));
    expect(await screen.findByText("已追加为 v2")).toBeVisible();
  });
});
