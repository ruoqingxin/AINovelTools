import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanBatchReceipt, PlanNode, PlanningSection } from "../lib/tauri-client";
import { ProjectWorkspaceView } from "./project-workspace-view";
import { AiWorkspaceContext } from "./content-identity";

const mocks = vi.hoisted(() => ({
  listPlanNodes: vi.fn(), getCurrentProject: vi.fn(), listPlanningSections: vi.fn(), listModelProfiles: vi.fn(),
  getAuditFlowSettings: vi.fn(), savePlanningSection: vi.fn(),
  adoptPlanBatch: vi.fn(), createPlanNode: vi.fn(),
  currentManuscript: vi.fn(), currentManuscriptDraft: vi.fn(),
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
  useChapterManuscript: () => ({ manuscript: {}, draft: "", chapterDirty: false, savingDraft: false, draftNeedsPersistence: false, setManuscriptTab: vi.fn() }),
}));
vi.mock("./planning-discussion-sources", () => ({ PlanningDiscussionSources: () => null }));
vi.mock("./chapter-entity-reference-panel", () => ({ ChapterEntityReferencePanel: () => null }));

const scene: PlanNode = { id: "scene-1", kind: "SCENE", parentId: null, title: "重逢", archived: false, revision: 1, sortOrder: 0 };
function renderPlan(search = "?planNode=scene-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D重逢%26type%3DPLAN", aiWorkspace = true, mode: "planning" | "writing" = "planning") {
  window.history.replaceState(null, "", `/planning${search}`);
  render(<AiWorkspaceContext.Provider value={aiWorkspace}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectWorkspaceView mode={mode} /></QueryClientProvider></AiWorkspaceContext.Provider>);
}

describe("exact planning navigation", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/");
    window.localStorage.removeItem("ainoveltools:last-writing-chapter:project-1"); });
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
    mocks.currentManuscript.mockResolvedValue(null);
    mocks.currentManuscriptDraft.mockResolvedValue(null);
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

  it("selects the router target rather than the previous browser address", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/discussion?work=section&targetProject=project-1&item=seed-tone");
    const root = createRootRoute();
    const route = createRoute({ getParentRoute: () => root, path: "/discussion", component: ProjectWorkspaceView });
    const router = createRouter({ routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/discussion?work=planning&targetProject=project-1&planNode=scene-1"] }) });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>);
    expect(await screen.findByDisplayValue("场景的正式计划")).toBeVisible();
    expect(screen.queryByRole("main", { name: "全书大纲" })).not.toBeInTheDocument();
  });

  it("shows a focused outline reader and a single navigable directory even when preparation is incomplete", async () => {
    const manager: PlanNode = { ...scene, id: "manager", kind: "VOLUME_MANAGER", title: "分卷管理" };
    const volume: PlanNode = { ...scene, id: "volume", kind: "VOLUME", title: "第一卷", parentId: manager.id };
    const chapter: PlanNode = { ...scene, id: "chapter", kind: "CHAPTER", title: "第一章 入城", parentId: volume.id };
    mocks.listPlanNodes.mockResolvedValue([
      { ...scene, id: "work", kind: "WORK_DESIGN", title: "旧作品设定" },
      manager, volume, chapter, { ...scene, parentId: chapter.id },
    ]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:chapter", content: "章节计划：调查失踪来信", pendingContent: "", storyState: "CONFIRMED",
      rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    renderPlan("?work=planning&targetProject=project-1");
    const reader = await screen.findByRole("main", { name: "全书大纲" });
    expect(within(reader).getByRole("button", { name: "编写全书大纲" })).toBeVisible();
    expect(within(reader).getByRole("button", { name: "规划分卷与章节" })).toBeVisible();
    expect(within(reader).getByText("1 卷 · 1 章 · 1 场景")).toBeVisible();
    expect(within(reader).queryByText("第一章 入城")).not.toBeInTheDocument();
    expect(screen.queryByText(/规划总览|大纲总览/)).not.toBeInTheDocument();
    expect(screen.queryByText(/关键准备待确认|继续当前准备|本书偏好|规划参考/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导出正文/ })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByLabelText("规划树")).getByRole("button", { name: "第一章 入城" }));
    expect(await screen.findByRole("region", { name: "章节细纲编辑" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "本章计划" })).toHaveValue("章节计划：调查失踪来信");
    expect(screen.queryByRole("button", { name: /保存正文|展开写作助手|导出正文/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "已保存正文" })).not.toBeInTheDocument();
  });

  it("gives an empty normal outline page distinct writing and structure destinations without creating anything", async () => {
    mocks.listPlanNodes.mockResolvedValue([]);
    mocks.listPlanningSections.mockResolvedValue([]);
    renderPlan("", false);
    expect(await screen.findByRole("main", { name: "全书大纲" })).toBeVisible();
    expect(screen.getByRole("link", { name: "编写全书大纲" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1");
    expect(screen.getByRole("link", { name: "规划分卷与章节" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&item=structure");
    expect(screen.getByRole("link", { name: /全书大纲.*未编写/ })).toHaveAttribute("data-selected", "true");
    expect(screen.queryByText("目录选项")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /打开全书大纲|分卷与章节规划|主线大纲|新建章节|导出正文/ })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it.each(["", "?planNode=outline&targetProject=project-1"])("displays formal full-book content consistently with exact edit and structure links: %s", async (search) => {
    mocks.listPlanNodes.mockResolvedValue([
      { ...scene, id: "outline", kind: "OUTLINE", title: "主线大纲" },
      { ...scene, id: "manager", kind: "VOLUME_MANAGER", title: "结构" },
    ]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:outline", content: "正式全书大纲内容", pendingContent: "尚未采用的候选",
      storyState: "CONFIRMED", rationale: "", consequence: "", references: [], version: 1, updatedAt: "",
    }]);
    renderPlan(search, false);
    const reader = await screen.findByRole("main", { name: "全书大纲" });
    expect(within(reader).getByText("正式全书大纲内容")).toBeVisible();
    expect(screen.queryByText("尚未采用的候选")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /正式规划/ })).not.toBeInTheDocument();
    expect(within(reader).getByRole("link", { name: "修改全书大纲" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&planNode=outline");
    expect(within(reader).getByRole("link", { name: "规划分卷与章节" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&planNode=manager");
    expect(within(reader).getByRole("status")).toHaveTextContent("有待确认工作稿");
    expect(within(reader).getByText("正式全书大纲内容")).toHaveClass("outline-reader-text");
    expect(within(reader).getByRole("link", { name: "规划分卷与章节" }).closest(".outline-reader-toolbar")).not.toBeNull();
  });

  it("does not claim that the full-book outline is empty while planning is loading or unavailable", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "outline", kind: "OUTLINE", title: "主线大纲" }]);
    let reject!: (error: Error) => void;
    mocks.listPlanningSections.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    renderPlan("", false);
    const reader = await screen.findByRole("main", { name: "全书大纲" });
    expect(within(reader).getByRole("status")).toHaveTextContent("正在读取全书大纲");
    expect(within(reader).queryByText("尚无正式全书大纲")).not.toBeInTheDocument();
    expect(within(reader).queryByRole("link", { name: "编写全书大纲" })).not.toBeInTheDocument();
    await act(async () => reject(new Error("规划读取失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("规划读取失败");
    expect(within(reader).getByRole("status")).toHaveTextContent("暂时无法读取全书大纲");
    expect(within(reader).queryByText("尚无正式全书大纲")).not.toBeInTheDocument();
  });

  it.each([
    ["SCENE", "场景安排", "planning", ""],
    ["CHAPTER", "章节细纲", "writing", "&tab=plan&assistant=plan"],
    ["VOLUME_MANAGER", "分卷与章节结构", "planning", ""],
  ] as const)("uses the focused outline reader for %s without exposing candidates or editing controls", async (kind, subtype, workflow, extra) => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, kind }]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:scene-1", content: "", pendingContent: "尚未采用的规划候选",
      storyState: "DRAFT", rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    renderPlan("?planNode=scene-1&targetProject=project-1&returnTo=%2Fsearch", false);
    const reader = await screen.findByRole("region", { name: "重逢正式内容" });
    expect(reader).toHaveClass("formal-content-reader");
    expect(within(reader).getByRole("heading", { name: `暂无正式${subtype}` })).toBeVisible();
    expect(within(reader).getByRole("status")).toHaveTextContent("有待核对工作稿");
    const entry = within(reader).getByRole("link", { name: "去共创处理重逢" });
    expect(entry).toHaveTextContent(`核对${subtype}`);
    expect(entry).toHaveAttribute("href", `/discussion?work=${workflow}&targetProject=project-1&planNode=scene-1${extra}&returnTo=%2Fsearch`);
    expect(within(reader).queryByText("尚未采用的规划候选")).not.toBeInTheDocument();
    expect(within(reader).queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("reads a saved scene plan with a compact editing entry and preserves its paragraph text", async () => {
    renderPlan("?planNode=scene-1&targetProject=project-1", false);
    const reader = await screen.findByRole("region", { name: "重逢正式内容" });
    expect(within(reader).getByText("场景的正式计划")).toBeVisible();
    const entry = within(reader).getByRole("link", { name: "去共创处理重逢" });
    expect(entry).toHaveTextContent("编辑场景安排");
    expect(entry.closest(".formal-reader-toolbar")).not.toBeNull();
    expect(within(reader).queryByText("暂无正式场景安排")).not.toBeInTheDocument();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps an unavailable scene plan out of the empty reader state", async () => {
    let reject!: (error: Error) => void;
    mocks.listPlanningSections.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    renderPlan("?planNode=scene-1&targetProject=project-1", false);
    const reader = await screen.findByRole("region", { name: "重逢正式内容" });
    expect(within(reader).getByRole("status")).toHaveTextContent("正在读取规划");
    expect(within(reader).queryByRole("link")).not.toBeInTheDocument();
    await act(async () => reject(new Error("规划读取失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("规划读取失败");
    expect(within(reader).getByRole("status")).toHaveTextContent("暂时无法读取规划");
    expect(within(reader).queryByText("暂无正式场景安排")).not.toBeInTheDocument();
  });

  it("lands a missing structure target on the structure task rather than another full-book overview", async () => {
    mocks.listPlanNodes.mockResolvedValue([]);
    renderPlan("?work=planning&targetProject=project-1&item=structure");
    expect(await screen.findByRole("main", { name: "分卷与章节" })).toBeVisible();
    expect(screen.getByRole("button", { name: "开始规划分卷与章节" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "编写全书大纲" })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  function emptyStructureSetup(sections: PlanningSection[] = []) {
    const manager: PlanNode = { ...scene, id: "manager", kind: "VOLUME_MANAGER", title: "分卷管理" };
    const volume: PlanNode = { ...scene, id: "volume", kind: "VOLUME", title: "第一卷", parentId: manager.id };
    const chapter: PlanNode = { ...scene, id: "chapter", kind: "CHAPTER", title: "第1章", parentId: volume.id };
    mocks.listPlanNodes.mockResolvedValue([manager, volume, chapter]);
    mocks.listPlanningSections.mockResolvedValue(sections);
    return { manager, volume, chapter };
  }

  function structureSection(id: string, content = "", pendingContent = ""): PlanningSection {
    return { id, content, pendingContent, storyState: "CONFIRMED", version: 1,
      rationale: "", consequence: "", references: [], updatedAt: "" };
  }

  it("hides empty starter volumes and chapters until planning begins and exposes one direct generation action", async () => {
    emptyStructureSetup();
    renderPlan("?planNode=manager&targetProject=project-1");
    await screen.findByRole("heading", { name: "分卷与章节" });
    const tree = screen.getByLabelText("规划树");
    expect(within(tree).getByRole("button", { name: "分卷与章节" })).toBeVisible();
    expect(within(tree).queryByRole("button", { name: "第一卷" })).not.toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: "第1章" })).not.toBeInTheDocument();
    expect(within(tree).queryByRole("textbox", { name: "搜索章节" })).not.toBeInTheDocument();
    expect(screen.queryByText("1 卷 · 1 章")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分卷方案" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "本卷章节" })).toBeDisabled();
    expect(screen.queryByLabelText("拆章节目标分卷")).not.toBeInTheDocument();
    const generate = screen.getByRole("button", { name: "生成分卷方案" });
    expect(generate).toBeVisible();
    expect(generate.closest("details")).toBeNull();
    expect(screen.getByText("手动添加").closest("details")).not.toHaveAttribute("open");
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("目录选项"));
    fireEvent.click(screen.getByRole("checkbox", { name: "显示已删除节点" }));
    expect(within(tree).getByRole("button", { name: "第一卷" })).toBeVisible();
    expect(within(tree).getByRole("button", { name: "第1章" })).toBeVisible();
  });

  it("does not count empty starter nodes on the full-book outline", async () => {
    emptyStructureSetup();
    renderPlan("", false);
    const reader = await screen.findByRole("main", { name: "全书大纲" });
    expect(within(reader).getByText("0 卷 · 0 章 · 0 场景")).toBeVisible();
    expect(within(screen.getByLabelText("规划树")).queryByRole("button", { name: "第一卷" })).not.toBeInTheDocument();
  });

  it("keeps volume candidates editable without treating them as an adopted directory", async () => {
    emptyStructureSetup([structureSection("plan-node:manager", "", "第1卷·雾城｜寻找寄件人")]);
    renderPlan("?planNode=manager&targetProject=project-1");
    expect(await screen.findByLabelText("分卷候选")).toHaveValue("第1卷·雾城｜寻找寄件人");
    expect(screen.getByRole("button", { name: "本卷章节" })).toBeDisabled();
    expect(within(screen.getByLabelText("规划树")).queryByRole("button", { name: "第一卷" })).not.toBeInTheDocument();
    expect(mocks.adoptPlanBatch).not.toHaveBeenCalled();
  });

  it("retains an established directory and chapter candidates while a later volume revision awaits review", async () => {
    emptyStructureSetup([
      structureSection("plan-node:manager", "已采用的分卷方案"),
      structureSection("plan-node:volume", "已确认的本卷规划", "后续修改，尚未采用"),
      structureSection("chapter-split-volume", "", "第2章·问路｜发现冲突"),
    ]);
    renderPlan("?planNode=manager&targetProject=project-1");
    const editor = await screen.findByLabelText("章节拆分候选");
    expect(editor).toHaveValue("第2章·问路｜发现冲突");
    expect(screen.getByRole("button", { name: "本卷章节" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByLabelText("规划树")).getByRole("button", { name: "第一卷" })).toBeVisible();
    expect(screen.getByRole("button", { name: "拆分本卷章节" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "审定本卷规划" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&planNode=volume");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps saved child drafts reachable even before a volume plan is confirmed", async () => {
    emptyStructureSetup([structureSection("plan-node:chapter", "", "作者已写下的章节草稿")]);
    renderPlan("?planNode=manager&targetProject=project-1");
    await screen.findByRole("heading", { name: "分卷与章节" });
    expect(within(screen.getByLabelText("规划树")).getByRole("button", { name: "第1章" })).toBeVisible();
    expect(screen.getByRole("button", { name: "本卷章节" })).toBeDisabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("preserves direct navigation to an empty volume without making it a completed plan", async () => {
    emptyStructureSetup();
    renderPlan("?planNode=volume&targetProject=project-1");
    expect(await screen.findByLabelText("编辑节点标题")).toHaveValue("第一卷");
    expect(within(screen.getByLabelText("规划树")).getByRole("button", { name: "第一卷" })).toHaveAttribute("data-selected", "true");
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("opens a manually added volume for planning instead of leaving it in the hidden empty directory", async () => {
    const { manager, volume, chapter } = emptyStructureSetup();
    const created: PlanNode = { ...volume, id: "manual-volume", title: "新的分卷" };
    mocks.createPlanNode.mockImplementation(async () => {
      mocks.listPlanNodes.mockResolvedValue([manager, volume, chapter, created]);
      return created;
    });
    renderPlan("?planNode=manager&targetProject=project-1");
    await screen.findByRole("heading", { name: "分卷与章节" });
    fireEvent.click(screen.getByText("手动添加"));
    fireEvent.change(screen.getByLabelText("父节点"), { target: { value: manager.id } });
    fireEvent.change(screen.getByLabelText("节点标题"), { target: { value: created.title } });
    fireEvent.click(screen.getByRole("button", { name: "创建分卷" }));
    expect(await screen.findByLabelText("编辑节点标题")).toHaveValue(created.title);
    expect(mocks.createPlanNode).toHaveBeenCalledWith({ kind: "VOLUME", title: created.title, parentId: manager.id });
    expect(within(screen.getByLabelText("规划树")).getByRole("button", { name: created.title })).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it.each([false, true])("hides unplanned empty writing nodes without reopening a remembered placeholder in AI workspace=%s", async (aiWorkspace) => {
    emptyStructureSetup();
    window.localStorage.setItem("ainoveltools:last-writing-chapter:project-1", "chapter");
    renderPlan("?targetProject=project-1", aiWorkspace, "writing");
    expect(await screen.findByRole("heading", { name: "尚未规划分卷与章节" })).toBeVisible();
    expect(screen.getByRole("link", { name: "规划分卷与章节" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&planNode=manager");
    expect(screen.queryByRole("button", { name: "第一卷" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "第1章" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索章节" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "章节正文阅读" })).not.toBeInTheDocument();
    expect(screen.queryByText("导出正文")).not.toBeInTheDocument();
    expect(mocks.currentManuscript).toHaveBeenCalledWith("chapter");
    expect(mocks.currentManuscriptDraft).toHaveBeenCalledWith("chapter");
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it.each(["manuscript", "draft"])("keeps legacy writing content reachable without a volume plan: %s", async (kind) => {
    const { manager, volume, chapter } = emptyStructureSetup();
    const written: PlanNode = { ...chapter, id: "written", title: "已经写过的章节" };
    mocks.listPlanNodes.mockResolvedValue([manager, volume, chapter, written]);
    if (kind === "manuscript") mocks.currentManuscript.mockImplementation(async (id) =>
      id === written.id ? { id: "revision", chapterId: id, documentJson: "已有正文" } : null);
    else mocks.currentManuscriptDraft.mockImplementation(async (id) =>
      id === written.id ? { chapterId: id, documentJson: "已有草稿", version: 1 } : null);
    renderPlan("?targetProject=project-1", false, "writing");
    const directory = await screen.findByRole("button", { name: written.title });
    await waitFor(() => expect(directory).toHaveAttribute("data-selected", "true"));
    expect(screen.getByRole("button", { name: "第一卷" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "第1章" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "尚未规划分卷与章节" })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("does not claim writing is empty while checking manuscripts or after a read failure", async () => {
    emptyStructureSetup();
    let reject!: (error: Error) => void;
    mocks.currentManuscript.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    renderPlan("?targetProject=project-1", false, "writing");
    const workspace = await screen.findByRole("main", { name: "正文工作区" });
    expect(within(workspace).getByRole("status")).toHaveTextContent("正在读取章节");
    expect(screen.queryByRole("heading", { name: "尚未规划分卷与章节" })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.currentManuscript).toHaveBeenCalled());
    await act(async () => reject(new Error("正文读取失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法核对章节内容");
    expect(screen.getByRole("button", { name: "第1章" })).toBeVisible();
    expect(within(workspace).getByRole("status")).toHaveTextContent("暂时无法读取章节");
    mocks.currentManuscript.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "重试读取章节" }));
    expect(await screen.findByRole("heading", { name: "尚未规划分卷与章节" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "第1章" })).not.toBeInTheDocument();
  });

  it("retains writing navigation when planning evidence cannot be read instead of reporting an empty book", async () => {
    emptyStructureSetup();
    mocks.listPlanningSections.mockRejectedValue(new Error("规划读取失败"));
    renderPlan("?targetProject=project-1", false, "writing");
    expect(await screen.findByRole("button", { name: "第1章" })).toBeVisible();
    expect(screen.getByRole("button", { name: "第一卷" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "尚未规划分卷与章节" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("main", { name: "正文工作区" })).getByRole("status")).toHaveTextContent("暂时无法读取章节");
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("keeps an explicitly requested empty writing chapter accessible before planning", async () => {
    emptyStructureSetup();
    renderPlan("?planNode=chapter&targetProject=project-1", false, "writing");
    expect(await screen.findByRole("region", { name: "章节正文阅读" })).toBeVisible();
    expect(screen.getByRole("button", { name: "第1章" })).toHaveAttribute("data-selected", "true");
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("shows an established writing directory without scanning unrelated manuscripts", async () => {
    emptyStructureSetup([structureSection("plan-node:volume", "已有分卷规划", "待审的新候选")]);
    renderPlan("?targetProject=project-1", false, "writing");
    expect(await screen.findByRole("region", { name: "章节正文阅读" })).toBeVisible();
    expect(screen.getByRole("button", { name: "第一卷" })).toBeVisible();
    expect(screen.getByRole("button", { name: "第1章" })).toHaveAttribute("data-selected", "true");
    expect(mocks.currentManuscript).not.toHaveBeenCalled();
    expect(mocks.currentManuscriptDraft).not.toHaveBeenCalled();
  });

  it.each(["planning", "writing"] as const)("shows an empty volume overview with distinct plan and reading destinations in %s", async (mode) => {
    const volume: PlanNode = { ...scene, id: "volume", kind: "VOLUME", title: "第一卷" };
    const chapter: PlanNode = { ...scene, id: "chapter", kind: "CHAPTER", title: "入城", parentId: volume.id };
    mocks.listPlanNodes.mockResolvedValue([
      volume, chapter,
      { ...chapter, id: "archived", archived: true },
      { ...chapter, id: "other", parentId: "another-volume" },
    ]);
    mocks.listPlanningSections.mockResolvedValue([]);
    renderPlan(`?${mode === "planning" ? "planNode=volume&" : ""}targetProject=project-1&returnTo=%2Fsearch`, false, mode);
    if (mode === "writing") fireEvent.click(await screen.findByRole("button", { name: "第一卷" }));
    const reader = await screen.findByRole("region", { name: "分卷概览" });
    expect(within(reader).getByRole("heading", { name: "第一卷" })).toBeVisible();
    expect(within(reader).getByText("分卷 · 1 章")).toBeVisible();
    expect(within(reader).getByRole("heading", { name: "暂无分卷规划" })).toBeVisible();
    expect(within(reader).getByRole("link", { name: "编写分卷规划" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&planNode=volume&returnTo=%2Fsearch");
    if (mode === "writing") expect(within(reader).getByRole("button", { name: "阅读本卷" })).toBeEnabled();
    else expect(within(reader).getByRole("link", { name: "阅读本卷" })).toHaveAttribute("href",
      "/writing?targetProject=project-1&planNode=chapter");
    expect(within(reader).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(reader).queryByText("暂无正式内容")).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    if (mode === "writing") {
      fireEvent.click(within(reader).getByRole("button", { name: "阅读本卷" }));
      expect(await screen.findByRole("region", { name: "章节正文阅读" })).toBeVisible();
      expect(screen.queryByRole("region", { name: "分卷概览" })).not.toBeInTheDocument();
    }
  });

  it("reads only the saved volume plan and keeps an unadopted candidate out of the reading pane", async () => {
    const volume: PlanNode = { ...scene, id: "volume", kind: "VOLUME", title: "第一卷" };
    mocks.listPlanNodes.mockResolvedValue([volume]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:volume", content: "正式分卷规划\n保留段落", pendingContent: "未采用的分卷候选",
      storyState: "CONFIRMED", rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    renderPlan("?targetProject=project-1", false, "writing");
    fireEvent.click(await screen.findByRole("button", { name: "第一卷" }));
    const reader = await screen.findByRole("region", { name: "分卷概览" });
    expect(within(reader).getByText(/正式分卷规划/)).toHaveTextContent("正式分卷规划 保留段落");
    expect(within(reader).getByRole("status")).toHaveTextContent("有待核对工作稿");
    expect(within(reader).getByRole("link", { name: "编辑分卷规划" })).toHaveAttribute("href",
      "/discussion?work=planning&targetProject=project-1&planNode=volume");
    expect(within(reader).queryByText("未采用的分卷候选")).not.toBeInTheDocument();
    expect(within(reader).queryByRole("button", { name: "阅读本卷" })).not.toBeInTheDocument();
    expect(within(reader).getByText("分卷 · 0 章")).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("offers candidate review for a volume without claiming that the candidate is a saved plan", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "volume", kind: "VOLUME", title: "第一卷" }]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:volume", content: "", pendingContent: "未采用的分卷候选",
      storyState: "DRAFT", rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    renderPlan("?targetProject=project-1", false, "writing");
    fireEvent.click(await screen.findByRole("button", { name: "第一卷" }));
    const reader = await screen.findByRole("region", { name: "分卷概览" });
    expect(within(reader).getByRole("heading", { name: "暂无分卷规划" })).toBeVisible();
    expect(within(reader).getByRole("link", { name: "核对分卷规划" })).toBeVisible();
    expect(within(reader).getByRole("status")).toHaveTextContent("有待核对工作稿");
    expect(within(reader).queryByText("未采用的分卷候选")).not.toBeInTheDocument();
  });

  it("does not show an empty volume plan while planning data is still loading or unavailable", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "volume", kind: "VOLUME", title: "第一卷" }]);
    let reject!: (error: Error) => void;
    mocks.listPlanningSections.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    renderPlan("?targetProject=project-1", false, "writing");
    fireEvent.click(await screen.findByRole("button", { name: "第一卷" }));
    const reader = await screen.findByRole("region", { name: "分卷概览" });
    expect(within(reader).getByRole("status")).toHaveTextContent("正在读取分卷规划");
    expect(within(reader).queryByText("暂无分卷规划")).not.toBeInTheDocument();
    await act(async () => reject(new Error("规划读取失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("规划读取失败");
    expect(within(reader).getByRole("status")).toHaveTextContent("暂时无法读取分卷规划");
    expect(within(reader).queryByRole("link", { name: "编写分卷规划" })).not.toBeInTheDocument();
  });

  it("exposes scene plans in the outline directory beneath their chapter", async () => {
    const manager: PlanNode = { ...scene, id: "manager", kind: "VOLUME_MANAGER", title: "分卷管理" };
    const volume: PlanNode = { ...scene, id: "volume", kind: "VOLUME", title: "第一卷", parentId: manager.id };
    const chapter: PlanNode = { ...scene, id: "chapter", kind: "CHAPTER", title: "第一章 入城", parentId: volume.id };
    mocks.listPlanNodes.mockResolvedValue([manager, volume, chapter, { ...scene, parentId: chapter.id }]);
    renderPlan();
    expect(await screen.findByRole("textbox", { name: "正式规划" })).toHaveValue("场景的正式计划");
    expect(within(screen.getByLabelText("规划树")).getByRole("button", { name: "重逢" })).toBeVisible();
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

  it("preserves early event drafts without treating a plain save as author confirmation", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "outline-1", kind: "OUTLINE", title: "大纲" }]);
    renderPlan("?planNode=outline-1&targetProject=project-1");
    fireEvent.click(await screen.findByRole("button", { name: "引发事件" }));
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
    expect(within(screen.getByRole("region", { name: "作者审阅" })).getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("这个故事的主线怎样发展？")).toBeVisible();
    expect(screen.getByRole("button", { name: "汇总为大纲草稿" })).toBeDisabled();
  });

  it.each(["?discussionTarget=seed-tone&targetProject=project-1", "?planNode=work&targetProject=project-1"])("rejects preparation records as outline targets: %s", async (search) => {
    const work = { ...scene, id: "work", kind: "WORK_DESIGN" as const, title: "原作品设定" };
    mocks.listPlanNodes.mockResolvedValue([work]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "engine-ending", content: "旧结局仍保留", pendingContent: "", storyState: "CONFIRMED",
      rationale: "", consequence: "", references: [], updatedAt: "", version: 3,
    }]);
    renderPlan(search);
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他规划项");
    expect(screen.queryByLabelText("篇幅、风格与边界")).not.toBeInTheDocument();
    expect(screen.queryByText("规划参考")).not.toBeInTheDocument();
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
    renderPlan("?planNode=chapter-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D入城%26type%3DPLAN", false);
    const url = new URL((await screen.findByRole("link", { name: "去共创处理入城" })).getAttribute("href")!, window.location.origin);
    expect(url.pathname).toBe("/discussion");
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

  it("uses read-only planning evidence and moves preference editing into creation preparation", async () => {
    const preferences: PlanningSection = {
      id: "seed-tone", content: "约 20 万字，大致三卷，章节数暂不定。轻松，第三人称。",
      pendingContent: "", storyState: "CONFIRMED", version: 5, rationale: "", consequence: "", references: [], updatedAt: "",
    };
    batchSetup(true, preferences);
    await screen.findByText("规划依据", { selector: ".volume-book-preferences > summary" });
    const disclosure = screen.getByText("规划依据", { selector: ".volume-book-preferences > summary" });
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(disclosure);
    expect(screen.getByText(`本书偏好：${preferences.content}`)).toBeVisible();
    expect(screen.queryByLabelText("篇幅、风格与边界")).not.toBeInTheDocument();
    const link = new URL(screen.getByRole("link", { name: "前往筹备修改偏好" }).getAttribute("href")!, window.location.origin);
    expect(link.searchParams.get("work")).toBe("section");
    expect(link.searchParams.get("item")).toBe("seed-tone");
    expect(link.searchParams.get("returnTo")).toBe("/discussion?work=planning&targetProject=project-1&planNode=manager");
    fireEvent.click(screen.getByRole("button", { name: "分卷方案" }));
    expect(screen.queryByLabelText("本书字数（万字）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("分卷数（卷）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("章节数（章）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "本卷章节" }));
    expect(screen.getByLabelText("本批章节数")).toBeInTheDocument();
    expect(screen.queryByText("未设置本卷章节目标")).not.toBeInTheDocument();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps volume candidates when a node switch is cancelled", async () => {
    batchSetup();
    const editor = await screen.findByLabelText("分卷候选");
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "第1卷·保留编辑｜目标未定" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /全书大纲/ }));
    expect(confirm).toHaveBeenCalled();
    expect(editor).toHaveValue("第1卷·保留编辑｜目标未定");
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

  it("reveals the adopted directory and advances to chapter splitting after a successful volume batch", async () => {
    const { source, parent } = batchSetup();
    const created: PlanNode = { ...parent, id: "created-volume", kind: "VOLUME", parentId: parent.id, title: "第1卷·入城" };
    const saved: PlanningSection = { ...source, content: source.pendingContent, pendingContent: "", version: 8 };
    const outline: PlanNode = { ...scene, id: "outline", kind: "OUTLINE", title: "大纲" };
    mocks.adoptPlanBatch.mockImplementation(async () => {
      mocks.listPlanNodes.mockResolvedValue([parent, outline, created]);
      mocks.listPlanningSections.mockResolvedValue([
        saved, structureSection("plan-node:outline", "正式大纲"), structureSection("plan-node:created-volume", "阶段目标"),
      ]);
      return { nodes: [created], source: saved };
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "采用并创建 2 个分卷" })).toBeEnabled());
    expect(within(screen.getByLabelText("规划树")).queryByRole("button", { name: created.title })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采用并创建 2 个分卷" }));
    await waitFor(() => expect(screen.getByLabelText("拆章节目标分卷")).toHaveValue(created.id));
    expect(within(screen.getByLabelText("规划树")).getByRole("button", { name: created.title })).toBeVisible();
    expect(screen.getByRole("button", { name: "本卷章节" })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.adoptPlanBatch).toHaveBeenCalledTimes(1);
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
