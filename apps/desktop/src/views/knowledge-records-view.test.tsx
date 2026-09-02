import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, ...mocks };
});

describe("KnowledgeRecordsView", () => {
  beforeEach(() => {
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
  });

  it("creates a relation from current facts and an evidence anchor", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KnowledgeRecordsView />
      </QueryClientProvider>,
    );

    const evidence = await screen.findByRole("checkbox", { name: "章节 chapter- · 区块 block-1" });
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
});
