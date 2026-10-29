import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StoryPlanningWorkbench } from "./story-planning-workbench";
import { emptyPlanningSection } from "./use-planning-draft";
import { AiWorkspaceContext } from "./content-identity";
import { BookPreparationView } from "./book-preparation-view";
import { emptyBookPreparation, readBookPreparation, withBookPreparation } from "./book-preparation";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";

const mocks = vi.hoisted(() => ({
  listPlanningSections: vi.fn(), savePlanningSection: vi.fn(), listModelProfiles: vi.fn(),
  getCurrentProject: vi.fn(), listDiscussionSessions: vi.fn(), listDiscussionMessages: vi.fn(),
  createDiscussionSession: vi.fn(), askProjectDiscussion: vi.fn(), getProjectAiTaskOverrides: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks }));
vi.mock("../lib/jobs-query", () => ({ useJobs: () => ({ data: [] }) }));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {} }),
}));
vi.mock("./planning-discussion-sources", () => ({ PlanningDiscussionSources: () => null }));
const stored = { ...emptyPlanningSection("seed-premise"), version: 4, content: "已有正式内容" };
function setup() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StoryPlanningWorkbench selectedSectionId="seed-premise" /></QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listModelProfiles.mockResolvedValue([]);
  mocks.getCurrentProject.mockResolvedValue({ projectId: "project" });
  mocks.listDiscussionSessions.mockResolvedValue([]);
  mocks.listDiscussionMessages.mockResolvedValue([]);
  mocks.getProjectAiTaskOverrides.mockResolvedValue({});
  mocks.listPlanningSections.mockResolvedValue([stored]);
  mocks.savePlanningSection.mockImplementation((section) => Promise.resolve({ ...section, version: 5 }));
});
afterEach(cleanup);
describe("planning content editor", () => {
  function prepare() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ConfirmActionProvider><BookPreparationView /></ConfirmActionProvider></QueryClientProvider>);
    return client;
  }

  it("starts with choice-first whole-book directions and keeps supplements collapsed", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    prepare();
    await screen.findByRole("heading", { name: "本书偏好" });
    for (const label of ["目标字数", "叙事视角", "语言风格", "整体基调"]) {
      expect(screen.getByRole("combobox", { name: label })).toBeVisible();
      expect(screen.getByRole("combobox", { name: label })).toHaveValue("");
    }
    expect(screen.queryByRole("textbox", { name: "核心故事" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "题材类型" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("节奏偏好")).not.toBeVisible();
    expect(screen.getByText("已记录 0 / 4")).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("saves selected directions together while preserving old candidates and original notes", async () => {
    mocks.listPlanningSections.mockResolvedValue([{
      ...emptyPlanningSection("seed-tone"), content: "旧笔记原文", pendingContent: "旧讨论候选", version: 7, references: ["discussion:old"],
    }]);
    prepare();
    await screen.findByRole("combobox", { name: "目标字数" });
    fireEvent.change(screen.getByRole("combobox", { name: "目标字数" }), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("combobox", { name: "叙事视角" }), { target: { value: "第三人称 · 限定视角" } });
    fireEvent.change(screen.getByRole("combobox", { name: "语言风格" }), { target: { value: "简洁直白" } });
    fireEvent.change(screen.getByRole("combobox", { name: "整体基调" }), { target: { value: "悬疑" } });
    expect(screen.getByText("已记录 4 / 4")).toBeVisible();
    fireEvent.click(screen.getByText("节奏、读者与边界"));
    fireEvent.click(screen.getByRole("checkbox", { name: "不写后宫" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "不靠误会拖剧情" }));
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledOnce());
    const saved = mocks.savePlanningSection.mock.calls[0][0];
    expect(saved).toMatchObject({ id: "seed-tone", version: 7, storyState: "CONFIRMED", pendingContent: "旧讨论候选",
      references: expect.arrayContaining(["discussion:old"]) });
    expect(readBookPreparation(saved)).toMatchObject({ genre: "", targetWords: "20", style: "简洁直白", premise: "", tone: "悬疑",
      notes: "旧笔记原文", boundaries: "不写后宫\n不靠误会拖剧情" });
    expect(mocks.savePlanningSection.mock.calls.every(([section]) => section.id === "seed-tone")).toBe(true);
  });

  it("allows custom choices and partial preparation without forcing a complete story", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    prepare();
    const style = await screen.findByRole("combobox", { name: "语言风格" });
    fireEvent.change(style, { target: { value: "__custom__" } });
    fireEvent.change(screen.getByRole("textbox", { name: "语言风格（自定义）" }), { target: { value: "轻喜剧，夹杂书信体" } });
    fireEvent.change(screen.getByRole("combobox", { name: "目标字数" }), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "目标字数（自定义）" }), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledOnce());
    expect(readBookPreparation(mocks.savePlanningSection.mock.calls[0][0])).toMatchObject({ targetWords: "12.5", style: "轻喜剧，夹杂书信体", genre: "", premise: "" });
  });

  it("requires confirmation for major changes and preserves the input when cancelled", async () => {
    mocks.listPlanningSections.mockResolvedValue([withBookPreparation({
      ...emptyPlanningSection("seed-tone"), version: 3, storyState: "CONFIRMED",
    }, { ...emptyBookPreparation(), style: "简洁直白" })]);
    prepare();
    fireEvent.change(await screen.findByRole("combobox", { name: "语言风格" }), { target: { value: "细腻写实" } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("已有正文和大纲保留");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "语言风格" })).toHaveValue("细腻写实");
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "保存新偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledOnce());
  });

  it("retains dirty selections after a remote version change and failed checked save", async () => {
    const original = withBookPreparation({ ...emptyPlanningSection("seed-tone"), version: 2 }, { ...emptyBookPreparation(), genre: "科幻" });
    mocks.listPlanningSections.mockResolvedValue([original]);
    mocks.savePlanningSection.mockRejectedValue(new Error("版本冲突"));
    const client = prepare();
    fireEvent.change(await screen.findByRole("combobox", { name: "目标字数" }), { target: { value: "50" } });
    act(() => client.setQueryData(["planning-sections"], [{ ...original, version: 3 }]));
    expect(await screen.findByRole("button", { name: "读取最新内容" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(screen.getByRole("combobox", { name: "目标字数" })).toHaveValue("50");
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));
  });

  it("shows confirmed directions without exposing pending candidates outside the AI workspace", async () => {
    mocks.listPlanningSections.mockResolvedValue([withBookPreparation({
      ...emptyPlanningSection("seed-tone"), pendingContent: "未确认的私有候选",
    }, { ...emptyBookPreparation(), genre: "都市悬疑", targetWords: "20" })]);
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={new QueryClient()}>
      <BookPreparationView /></QueryClientProvider></AiWorkspaceContext.Provider>);
    expect(await screen.findByText("20")).toBeVisible();
    fireEvent.click(screen.getByText("历史故事方向"));
    expect(screen.getByText("都市悬疑")).toBeVisible();
    expect(screen.queryByText("未确认的私有候选")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "编辑偏好" })).toHaveAttribute("href", "/discussion?work=preparation&targetProject=project");
  });

  it("only replaces directions with a candidate after explicit approval and discards stale form metadata", async () => {
    mocks.listPlanningSections.mockResolvedValue([withBookPreparation({
      ...emptyPlanningSection("seed-tone"), version: 8, pendingContent: "新的全书讨论方向", references: ["discussion:source"],
    }, { ...emptyBookPreparation(), genre: "科幻", style: "简洁直白" })]);
    prepare();
    const adopt = await screen.findByRole("button", { name: "采用为本书偏好" });
    fireEvent.click(adopt);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "语言风格" })).toHaveValue("简洁直白");
    await waitFor(() => expect(adopt).toBeEnabled());
    fireEvent.click(adopt);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "采用为本书偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledOnce());
    const saved = mocks.savePlanningSection.mock.calls[0][0];
    expect(saved).toMatchObject({ version: 8, content: "新的全书讨论方向", pendingContent: "", references: ["discussion:source"] });
    expect(readBookPreparation(saved)).toEqual({ ...emptyBookPreparation(), notes: "新的全书讨论方向" });
  });

  it("preserves a custom selection when reload is cancelled and reads the remote choices only after approval", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    const client = prepare();
    fireEvent.change(await screen.findByRole("combobox", { name: "语言风格" }), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByRole("textbox", { name: "语言风格（自定义）" }), { target: { value: "书信体" } });
    act(() => client.setQueryData(["planning-sections"], [withBookPreparation({
      ...emptyPlanningSection("seed-tone"), version: 3,
    }, { ...emptyBookPreparation(), style: "细腻写实" })]));
    fireEvent.click(await screen.findByRole("button", { name: "读取最新内容" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("textbox", { name: "语言风格（自定义）" })).toHaveValue("书信体");
    await waitFor(() => expect(screen.getByRole("button", { name: "读取最新内容" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "读取最新内容" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "读取最新内容" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "语言风格" })).toHaveValue("细腻写实"));
    expect(screen.queryByRole("textbox", { name: "语言风格（自定义）" })).not.toBeInTheDocument();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });
  it("keeps legacy story directions intact while editing preferences and links to exact story tasks", async () => {
    const oldFields = { ...emptyBookPreparation(), genre: "科幻", premise: "旧故事核心", experience: "旧阅读期待", ending: "旧结局倾向" };
    mocks.listPlanningSections.mockResolvedValue([withBookPreparation({
      ...emptyPlanningSection("seed-tone"), version: 9, references: ["discussion:legacy"], pendingContent: "旧候选",
    }, oldFields)]);
    prepare();
    fireEvent.change(await screen.findByRole("combobox", { name: "语言风格" }), { target: { value: "细腻写实" } });
    expect(screen.queryByRole("combobox", { name: "题材类型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "核心故事" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("历史故事方向"));
    for (const content of ["科幻", "旧故事核心", "旧阅读期待", "旧结局倾向"]) expect(screen.getByText(content)).toBeVisible();
    expect(screen.getByRole("link", { name: "前往故事准备：故事概念" })).toHaveAttribute("href",
      "/discussion?work=preparation&targetProject=project&item=premise");
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledOnce());
    const saved = mocks.savePlanningSection.mock.calls[0][0];
    expect(readBookPreparation(saved)).toEqual({ ...oldFields, style: "细腻写实" });
    expect(saved).toMatchObject({ version: 9, pendingContent: "旧候选", references: expect.arrayContaining(["discussion:legacy"]) });
  });
  it("shows only formal content outside AI and retains mixed preparation as unclassified", async () => {
    mocks.listPlanningSections.mockResolvedValue([{ ...stored, pendingContent: "未确认候选不能展示为正式内容" }]);
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-premise" />
    </QueryClientProvider></AiWorkspaceContext.Provider>);
    expect(await screen.findByText("已有正式内容")).toBeVisible();
    expect(screen.getByText("待归类 · 筹备")).toBeVisible();
    expect(screen.queryByText("未确认候选不能展示为正式内容")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /生成候选|发起讨论|保存规划/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去共创处理故事概念" })).toHaveAttribute("href",
      "/discussion?work=section&targetProject=project&item=seed-premise");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });
  it("discusses an existing setting without changing the formal version until confirmation", async () => {
    mocks.listModelProfiles.mockResolvedValue([{ id: "model", capability: "CHAT", hasSecret: true }]);
    const discussionSession = {
      id: "discussion", projectId: "project", scopeKind: "PROJECT",
      scopeText: JSON.stringify({ kind: "planning-section", sectionId: "seed-premise", title: "故事核心", question: "" }),
    };
    mocks.createDiscussionSession.mockImplementation(async () => {
      mocks.listDiscussionSessions.mockResolvedValue([discussionSession]);
      return discussionSession;
    });
    const answer = "我们聊出的新方向";
    const exchange = {
      userMessage: { id: "user", sessionId: "discussion", role: "USER", content: "我想重新考虑" },
      assistantMessage: { id: "ai", sessionId: "discussion", role: "ASSISTANT", content: answer },
    };
    mocks.askProjectDiscussion.mockImplementation(async () => {
      mocks.listDiscussionMessages.mockResolvedValue([exchange.userMessage, exchange.assistantMessage]);
      return exchange;
    });
    setup();
    await screen.findByRole("textbox", { name: "正式规划" });
    fireEvent.click(screen.getByRole("button", { name: "发起讨论" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "故事概念的讨论输入" })).toBeEnabled());
    fireEvent.change(await screen.findByRole("textbox", { name: "故事概念的讨论输入" }),
      { target: { value: "我想重新考虑" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "载入草稿" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "载入草稿" }));
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue(answer);
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认为正式内容" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-premise", content: answer, pendingContent: "", storyState: "CONFIRMED", version: 4,
    })));
  });

  it("saves book preferences directly with version checks and retains old candidates", async () => {
    const preferences = {
      ...emptyPlanningSection("seed-tone"), version: 7, storyState: "LOCKED" as const,
      content: "原篇幅和基调", pendingContent: "旧候选仍保留",
    };
    mocks.listPlanningSections.mockResolvedValue([preferences]);
    render(<QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-tone" /></QueryClientProvider>);
    const editor = await screen.findByLabelText("补充记录");
    await waitFor(() => expect(editor).toBeEnabled());
    expect(editor).not.toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "约 20 万字，轻松，第三人称。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-tone", content: "【补充记录】\n约 20 万字，轻松，第三人称。", pendingContent: "旧候选仍保留",
      version: 7, storyState: "LOCKED",
    })));
    expect(screen.getByLabelText("笔记状态")).not.toBeVisible();
  });

  it("does not replace book preference edits when a checked save fails", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.savePlanningSection.mockRejectedValue(new Error("版本冲突"));
    render(<QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-tone" /></QueryClientProvider>);
    const editor = await screen.findByLabelText("补充记录");
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "先写短篇，结局未定。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(editor).toHaveValue("先写短篇，结局未定。");
  });

  it("does not turn an author-reserved note into a formal setting on ordinary save", async () => {
    mocks.listPlanningSections.mockResolvedValue([{
      ...emptyPlanningSection("seed-tone"), content: "作者尚未公开的偏好", storyState: "AUTHOR_RESERVED", version: 6,
    }]);
    render(<QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-tone" /></QueryClientProvider>);
    const editor = await screen.findByLabelText("补充记录");
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "修改私有偏好，仍不公开。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      storyState: "AUTHOR_RESERVED", content: "【补充记录】\n修改私有偏好，仍不公开。", version: 6,
    })));
  });

  it("uses one save area for draft content and author state with the original version", async () => {
    setup();
    expect(await screen.findByRole("textbox", { name: "正式规划" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存状态" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑内容" }));
    fireEvent.change(screen.getByRole("textbox", { name: "规划草稿" }), { target: { value: "新的作者草稿" } });
    fireEvent.change(screen.getByLabelText("内容状态"), { target: { value: "AUTHOR_RESERVED" } });
    fireEvent.click(screen.getByRole("button", { name: "正式内容" }));
    fireEvent.click(screen.getByRole("button", { name: "草稿与候选" }));
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue("新的作者草稿");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      content: "已有正式内容", pendingContent: "新的作者草稿", storyState: "AUTHOR_RESERVED", version: 4,
    })));
  });
  it("allows an empty item to be authored without a model, preserving failed edits", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.savePlanningSection.mockRejectedValue(new Error("版本冲突"));
    setup();
    await screen.findByRole("textbox", { name: "正式规划" });
    fireEvent.click(screen.getByRole("button", { name: "编辑内容" }));
    fireEvent.change(screen.getByRole("textbox", { name: "规划草稿" }), { target: { value: "第一版构想" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue("第一版构想");
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({ version: 0, pendingContent: "第一版构想" }));
  });
});
