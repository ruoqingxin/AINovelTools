import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeRecordsView } from "./knowledge-records-view";

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
