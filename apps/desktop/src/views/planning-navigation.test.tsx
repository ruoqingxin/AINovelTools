import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanBatchReceipt, PlanNode, PlanningSection } from "../lib/tauri-client";
import { ProjectWorkspaceView } from "./project-workspace-view";

const mocks = vi.hoisted(() => ({
  listPlanNodes: vi.fn(), getCurrentProject: vi.fn(), listPlanningSections: vi.fn(), listModelProfiles: vi.fn(),
  getAuditFlowSettings: vi.fn(), savePlanningSection: vi.fn(),
  adoptPlanBatch: vi.fn(), createPlanNode: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("../lib/jobs-query", () => ({ useJobs: () => ({ data: [] }) }));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {} }),
}));
vi.mock("./use-chapter-manuscript", () => ({
  useChapterManuscript: () => ({ manuscript: {}, chapterDirty: false, savingDraft: false, draftNeedsPersistence: false, setManuscriptTab: vi.fn() }),
}));
vi.mock("./planning-discussion-sources", () => ({ PlanningDiscussionSources: () => null }));

const scene: PlanNode = { id: "scene-1", kind: "SCENE", parentId: null, title: "重逢", archived: false, revision: 1, sortOrder: 0 };
function renderPlan(search = "?planNode=scene-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D重逢%26type%3DPLAN") {
  window.history.replaceState(null, "", `/planning${search}`);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectWorkspaceView /></QueryClientProvider>);
}

describe("exact planning navigation", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listPlanNodes.mockResolvedValue([scene]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:scene-1", content: "场景的正式计划", pendingContent: "", storyState: "CONFIRMED",
      rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    mocks.listModelProfiles.mockResolvedValue([]);
    mocks.getAuditFlowSettings.mockResolvedValue({ admission: true, manuscript: true, knowledge: true });
  });

  it("opens the exact current node in the existing editor with a search return", async () => {
    renderPlan();
    expect(await screen.findByDisplayValue("场景的正式计划")).toBeVisible();
    const back = new URL(screen.getByRole("link", { name: "返回来源" }).getAttribute("href")!, window.location.origin);
    expect(back.searchParams.get("q")).toBe("重逢");
    expect(back.searchParams.get("type")).toBe("PLAN");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it.each([
    "?planNode=missing&targetProject=project-1", "?planNode=scene-1&targetProject=foreign",
    "?planNode=scene-1", "?planNode=&targetProject=project-1",
    "?planNode=scene-1&targetProject=project-1&discussionTarget=plan-node:scene-1",
  ])("rejects unavailable or ambiguous targets without opening another plan: %s", async (search) => {
    renderPlan(search);
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他规划项");
    expect(screen.queryByDisplayValue("场景的正式计划")).not.toBeInTheDocument();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("does not open an archived node", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, archived: true }]);
    renderPlan();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他规划项");
    expect(screen.queryByDisplayValue("场景的正式计划")).not.toBeInTheDocument();
  });

  it("retries a failed project check without falling back to another node", async () => {
    mocks.getCurrentProject.mockRejectedValueOnce(new Error("读取项目失败"));
    renderPlan();
    expect(await screen.findByRole("alert")).toHaveTextContent("无法核对目标项目");
    expect(screen.queryByDisplayValue("场景的正式计划")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试定位" }));
    expect(await screen.findByDisplayValue("场景的正式计划")).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps planning admission intact for an exact outline link", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "outline-1", kind: "OUTLINE", title: "大纲" }]);
    renderPlan("?planNode=outline-1&targetProject=project-1");
    expect(await screen.findByText("故事大纲尚未开放")).toBeVisible();
    expect(screen.queryByRole("button", { name: "保存规划" })).not.toBeInTheDocument();
  });

  it("keeps dirty plan edits when returning to the same target after a cancelled node switch", async () => {
    mocks.listPlanNodes.mockResolvedValue([scene, { ...scene, id: "scene-2", title: "离别" }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPlan();
    const input = await screen.findByDisplayValue("场景的正式计划");
    await act(async () => {});
    fireEvent.change(input, { target: { value: "作者尚未保存的计划" } });
    await waitFor(() => expect(input).toHaveValue("作者尚未保存的计划"));
    fireEvent.click(screen.getByRole("button", { name: /离别/ }));
    expect(confirm).toHaveBeenCalled();
    expect(input).toHaveValue("作者尚未保存的计划");
  });

  it("links a chapter result to its current plan assistant and preserves the return", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "chapter-1", kind: "CHAPTER", title: "入城" }]);
    renderPlan("?planNode=chapter-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D入城%26type%3DPLAN");
    const url = new URL((await screen.findByRole("link", { name: "查看本章计划" })).getAttribute("href")!, window.location.origin);
    expect(url.pathname).toBe("/writing");
    expect(url.searchParams.get("planNode")).toBe("chapter-1");
    expect(url.searchParams.get("assistant")).toBe("plan");
    const back = new URL(url.searchParams.get("returnTo")!, window.location.origin);
    expect(back.searchParams.get("q")).toBe("入城");
    expect(back.searchParams.get("type")).toBe("PLAN");
  });

  function batchSetup(split = false) {
    const manager: PlanNode = { ...scene, id: "manager", kind: "VOLUME_MANAGER", title: "分卷管理", revision: 4 };
    const volume: PlanNode = { ...scene, id: "volume", kind: "VOLUME", title: "第一卷", parentId: manager.id, revision: 3 };
    const outline: PlanNode = { ...scene, id: "outline", kind: "OUTLINE", title: "大纲" };
    const source: PlanningSection = {
      id: split ? "chapter-split-volume" : "plan-node:manager",
      content: "原正式计划", pendingContent: split ? "第1章·入城｜寻找线索\n第2章·问路｜发现冲突" : "第1卷·入城｜阶段目标\n第2卷·追查｜主要矛盾",
      storyState: "LOCKED", rationale: "作者理由", consequence: "作者后果", references: ["discussion:original"],
      updatedAt: "", version: 7,
    };
    const list = [manager, outline, ...(split ? [volume, { ...volume, id: "other-volume", title: "第二卷" }] : [])];
    mocks.listPlanNodes.mockResolvedValue(list);
    mocks.listPlanningSections.mockResolvedValue([
      source, { ...source, id: "plan-node:outline", content: "正式大纲", pendingContent: "", storyState: "CONFIRMED" },
    ]);
    renderPlan("?planNode=manager&targetProject=project-1");
    return { source, parent: split ? volume : manager };
  }

  it("adopts volumes through one batch using the original source and parent versions, preserving newer edits", async () => {
    let resolve!: (receipt: PlanBatchReceipt) => void;
    mocks.adoptPlanBatch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { source, parent } = batchSetup();
    const editor = await screen.findByLabelText("分卷候选");
    await waitFor(() => expect(screen.getByRole("button", { name: "采用并创建 2 个分卷" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 2 个分卷" }));
    await waitFor(() => expect(mocks.adoptPlanBatch).toHaveBeenCalledTimes(1));
    expect(mocks.adoptPlanBatch).toHaveBeenCalledWith({
      expectedProjectId: "project-1", parentId: parent.id, expectedParentRevision: 4, expectedSourceVersion: 7,
      source, candidates: [{ title: "第1卷·入城", content: "阶段目标" }, { title: "第2卷·追查", content: "主要矛盾" }],
    });
    fireEvent.change(editor, { target: { value: "第3卷·新增｜保存期间的新输入" } });
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 个分卷" }));
    const saved = { ...source, version: 8, content: source.pendingContent, pendingContent: "", storyState: "CONFIRMED" as const };
    const created: PlanNode = { ...parent, id: "created-volume", kind: "VOLUME", parentId: parent.id, title: "第1卷·入城" };
    await act(async () => { resolve({ nodes: [created], source: saved }); });
    expect(screen.getByLabelText("分卷候选")).toHaveValue("第3卷·新增｜保存期间的新输入");
    expect(mocks.adoptPlanBatch).toHaveBeenCalledTimes(1);
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("preserves volume candidates and their original CAS baseline after a conflict", async () => {
    mocks.adoptPlanBatch.mockRejectedValue({ code: "VERSION_CONFLICT", message: "规划版本冲突" });
    batchSetup();
    const editor = await screen.findByLabelText("分卷候选");
    await act(async () => {});
    fireEvent.change(editor, { target: { value: "第1卷·作者修改｜新目标" } });
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 个分卷" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("规划版本冲突");
    expect(editor).toHaveValue("第1卷·作者修改｜新目标");
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 个分卷" }));
    await waitFor(() => expect(mocks.adoptPlanBatch).toHaveBeenCalledTimes(2));
    expect(mocks.adoptPlanBatch.mock.calls[1][0].expectedSourceVersion).toBe(7);
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("adopts chapters with the formal source baseline and keeps newer candidate text while locking the target", async () => {
    let resolve!: (receipt: PlanBatchReceipt) => void;
    mocks.adoptPlanBatch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { source, parent } = batchSetup(true);
    const editor = await screen.findByLabelText("章节拆分候选");
    await waitFor(() => expect(screen.getByRole("button", { name: "采用并创建 2 章" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 2 章" }));
    await waitFor(() => expect(mocks.adoptPlanBatch).toHaveBeenCalledTimes(1));
    expect(mocks.adoptPlanBatch).toHaveBeenCalledWith({
      expectedProjectId: "project-1", parentId: parent.id, expectedParentRevision: 3, expectedSourceVersion: 7,
      source, candidates: [{ title: "第1章·入城", content: "寻找线索" }, { title: "第2章·问路", content: "发现冲突" }],
    });
    expect(screen.getByLabelText("拆章节目标分卷")).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空候选" })).toBeDisabled();
    fireEvent.change(editor, { target: { value: "第3章·新编辑｜追踪" } });
    await act(async () => { resolve({ nodes: [], source: { ...source, pendingContent: "", version: 8 } }); });
    expect(editor).toHaveValue("第3章·新编辑｜追踪");
    expect(screen.getByLabelText("拆章节目标分卷")).toBeEnabled();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps all chapter candidates on a failed batch instead of clearing the source", async () => {
    mocks.adoptPlanBatch.mockRejectedValue(new Error("执行卡写入失败"));
    batchSetup(true);
    const editor = await screen.findByLabelText("章节拆分候选");
    await waitFor(() => expect(screen.getByRole("button", { name: "采用并创建 2 章" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 2 章" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("执行卡写入失败");
    expect(editor).toHaveValue("第1章·入城｜寻找线索\n第2章·问路｜发现冲突");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("keeps unsaved chapter candidates and the target when a volume switch is cancelled", async () => {
    batchSetup(true);
    const editor = await screen.findByLabelText("章节拆分候选");
    await act(async () => {});
    fireEvent.change(editor, { target: { value: "第3章·作者修改｜新目标" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.change(screen.getByLabelText("拆章节目标分卷"), { target: { value: "other-volume" } });
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText("拆章节目标分卷")).toHaveValue("volume");
    expect(editor).toHaveValue("第3章·作者修改｜新目标");
  });
});
