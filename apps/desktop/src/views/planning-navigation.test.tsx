import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listPlanNodes.mockResolvedValue([scene]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:scene-1", content: "场景的正式计划", pendingContent: "", storyState: "CONFIRMED",
      rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    mocks.listModelProfiles.mockResolvedValue([]);
    mocks.getAuditFlowSettings.mockResolvedValue({ admission: true, manuscript: true, knowledge: true });
  });

  it("opens the exact node and retains its source for the unified workspace header", async () => {
    renderPlan();
    expect(await screen.findByDisplayValue("场景的正式计划")).toBeVisible();
    expect(screen.queryByRole("link", { name: "返回来源" })).not.toBeInTheDocument();
    const back = new URL(new URLSearchParams(window.location.search).get("returnTo")!, window.location.origin);
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

  it("allows early outline drafts but never confirms incomplete preparation through a plain save", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "outline-1", kind: "OUTLINE", title: "大纲" }]);
    renderPlan("?planNode=outline-1&targetProject=project-1");
    const note = await screen.findByLabelText("引发事件");
    await waitFor(() => expect(note).toBeEnabled());
    expect(screen.queryByText("故事大纲尚未开放")).not.toBeInTheDocument();
    expect(note).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    mocks.savePlanningSection.mockImplementation(async (section) => ({ ...section, version: 1 }));
    fireEvent.change(note, { target: { value: "先写一个接到旧电话的开场，结局不定。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "outline-step-outline-1-inciting", content: "", pendingContent: "先写一个接到旧电话的开场，结局不定。", storyState: "UNSET", version: 0,
    })));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "汇总审阅" }));
    expect(screen.getByRole("button", { name: "确认为正式大纲" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "作者审阅" })).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("这个故事的主线怎样发展？")).toBeVisible();
    expect(screen.getByRole("button", { name: "汇总为大纲草稿" })).toBeDisabled();
  });

  it("keeps old planning notes behind optional references without completion pressure", async () => {
    const work = { ...scene, id: "work", kind: "WORK_DESIGN" as const, title: "原作品设定" };
    mocks.listPlanNodes.mockResolvedValue([work]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "engine-ending", content: "旧结局仍保留", pendingContent: "", storyState: "CONFIRMED",
      rationale: "", consequence: "", references: [], updatedAt: "", version: 3,
    }]);
    renderPlan("?discussionTarget=seed-tone&targetProject=project-1");
    await screen.findByLabelText("篇幅、风格与边界");
    expect(screen.queryByText("核心")).not.toBeInTheDocument();
    expect(screen.queryByText("待明确")).not.toBeInTheDocument();
    const reference = screen.getByText("规划参考").closest("details")!;
    expect(reference).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("规划参考"));
    fireEvent.click(screen.getByRole("button", { name: "故事驱动" }));
    fireEvent.click(screen.getByRole("button", { name: /结局状态与承诺兑现/ }));
    expect(await screen.findByDisplayValue("旧结局仍保留")).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps dirty plan edits when returning to the same target after a cancelled node switch", async () => {
    mocks.listPlanNodes.mockResolvedValue([scene, { ...scene, id: "scene-2", title: "离别" }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPlan();
    expect(await screen.findByDisplayValue("场景的正式计划")).toHaveAttribute("readonly");
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑规划" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "编辑规划" }));
    const input = screen.getByLabelText("规划草稿");
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

  function batchSetup(split = false, preferences?: PlanningSection) {
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
      ...(split ? [{ ...source, id: "plan-node:volume", content: "本卷正式计划", pendingContent: "", storyState: "CONFIRMED" as const }] : []),
      ...(preferences ? [preferences] : []),
    ]);
    renderPlan("?planNode=manager&targetProject=project-1");
    return { source, parent: split ? volume : manager };
  }

  it("shares one natural-language preference note with volume planning and preserves edits across tools", async () => {
    let preferences: PlanningSection = {
      id: "seed-tone", content: "约 20 万字，大致三卷，章节数暂不定。轻松，第三人称。",
      pendingContent: "", storyState: "CONFIRMED", version: 5, rationale: "", consequence: "", references: [], updatedAt: "",
    };
    batchSetup(true, preferences);
    await screen.findByText(preferences.content, { selector: ".volume-book-preferences-preview" });
    const disclosure = screen.getByText("本书偏好", { selector: ".volume-book-preferences > summary" });
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(disclosure);
    const editor = screen.getByLabelText("篇幅、风格与边界");
    await waitFor(() => expect(editor).toHaveValue(preferences.content));
    expect(editor.getAttribute("placeholder")).not.toContain("\n");
    fireEvent.change(editor, { target: { value: "约 30 万字，四卷，节奏克制。" } });
    fireEvent.click(screen.getByRole("button", { name: "分卷方案" }));
    expect(editor).toHaveValue("约 30 万字，四卷，节奏克制。");
    expect(screen.queryByLabelText("本书字数（万字）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("分卷数（卷）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("章节数（章）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "本卷章节" }));
    expect(editor).toHaveValue("约 30 万字，四卷，节奏克制。");
    expect(screen.getByLabelText("本批章节数")).toBeInTheDocument();
    expect(screen.queryByText("未设置本卷章节目标")).not.toBeInTheDocument();
    mocks.savePlanningSection.mockImplementation(async (input) => {
      preferences = { ...input, version: 6 };
      mocks.listPlanningSections.mockResolvedValue([
        ...(await mocks.listPlanningSections()).filter((item: PlanningSection) => item.id !== preferences.id), preferences,
      ]);
      return preferences;
    });
    fireEvent.click(screen.getByRole("button", { name: "保存笔记" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-tone", version: 5, content: "约 30 万字，四卷，节奏克制。", storyState: "CONFIRMED",
    })));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存笔记" })).toBeDisabled());
    fireEvent.click(disclosure);
    expect(screen.getByText(preferences.content, { selector: ".volume-book-preferences-preview" })).toBeVisible();
  });

  it("keeps inline preference edits when a node switch is cancelled", async () => {
    batchSetup(true);
    await screen.findByLabelText("篇幅、风格与边界");
    fireEvent.click(screen.getByText("本书偏好", { selector: ".volume-book-preferences > summary" }));
    const editor = screen.getByLabelText("篇幅、风格与边界");
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "篇幅暂不定，写得轻松些。" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "第一卷" }));
    expect(confirm).toHaveBeenCalled();
    expect(editor).toHaveValue("篇幅暂不定，写得轻松些。");
  });

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

  it("creates only selected volumes atomically after explicitly confirming unselected candidates", async () => {
    const { source, parent } = batchSetup();
    mocks.adoptPlanBatch.mockResolvedValue({ nodes: [], source: { ...source, pendingContent: "", version: 8 } });
    await screen.findByLabelText("候选1名称");
    await waitFor(() => expect(screen.getByLabelText("候选1名称")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("候选1名称"), { target: { value: "作者改名" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "创建第2卷·追查" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 个分卷" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("候选区会清空"));
    expect(mocks.adoptPlanBatch).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 个分卷" }));
    await waitFor(() => expect(mocks.adoptPlanBatch).toHaveBeenCalledWith(expect.objectContaining({
      parentId: parent.id, expectedSourceVersion: 7, expectedParentRevision: 4,
      candidates: [{ title: "第1卷·作者改名", content: "阶段目标" }],
      source: expect.objectContaining({ pendingContent: "第1卷·作者改名｜阶段目标" }),
    })));
  });

  it("does not parse chapter names mentioned inside an edited structured plan as extra candidates", async () => {
    const { source } = batchSetup(true);
    mocks.adoptPlanBatch.mockResolvedValue({ nodes: [], source: { ...source, pendingContent: "", version: 8 } });
    await screen.findByLabelText("候选1计划");
    await waitFor(() => expect(screen.getByLabelText("候选1计划")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("候选1计划"), { target: { value: "与第9章·重逢的线索呼应" } });
    expect(screen.getByRole("button", { name: "采用并创建 2 章" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 2 章" }));
    await waitFor(() => expect(mocks.adoptPlanBatch).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [{ title: "第1章·入城", content: "与第9章·重逢的线索呼应" }, { title: "第2章·问路", content: "发现冲突" }],
    })));
  });

  it("adopts only selected chapters while preserving the formal source and its version", async () => {
    const { source, parent } = batchSetup(true);
    mocks.adoptPlanBatch.mockResolvedValue({ nodes: [], source: { ...source, pendingContent: "", version: 8 } });
    await waitFor(() => expect(screen.getByLabelText("候选1名称")).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "创建第2章·问路" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 章" }));
    expect(mocks.adoptPlanBatch).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("本批候选区会清空"));
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 1 章" }));
    await waitFor(() => expect(mocks.adoptPlanBatch).toHaveBeenCalledWith({
      expectedProjectId: "project-1", parentId: parent.id, expectedParentRevision: 3, expectedSourceVersion: 7,
      source, candidates: [{ title: "第1章·入城", content: "寻找线索" }],
    }));
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });
});
