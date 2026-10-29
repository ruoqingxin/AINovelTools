import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAiWorkspace as render } from "../test/render-ai-workspace";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CreationPreparationView } from "./creation-preparation-view";
import { buildPreparationStages } from "./creation-preparation";
import { emptyPlanningSection } from "./use-planning-draft";
import { openingReviewChecks, outlineReviewChecks, readPlanningReview, withPlanningReview } from "./planning-review";
import { assembleOutline, buildOutlineSteps, withOutlineSources } from "./outline-steps";
import { AiWorkspaceContext } from "./content-identity";

const mocks = vi.hoisted(() => ({
  getCurrentProject: vi.fn(), listPlanNodes: vi.fn(), listPlanningSections: vi.fn(),
  listModelProfiles: vi.fn(), savePlanningSection: vi.fn(), createPlanNode: vi.fn(),
  enqueuePlanningAiJob: vi.fn(), jobs: [] as unknown[],
  listDiscussionSessions: vi.fn(), listDiscussionMessages: vi.fn(), createDiscussionSession: vi.fn(),
  askProjectDiscussion: vi.fn(), getProjectAiTaskOverrides: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("@tanstack/react-router", async () => ({
  ...await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router"),
  Link: ({ to, hash, search: _search, children, ...props }: { to: string; hash?: string; search?: unknown; children: ReactNode }) =>
    <a href={`${to}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>,
}));
vi.mock("../lib/jobs-query", () => ({ useJobs: () => ({ data: mocks.jobs }) }));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {}, isSuccess: true }),
}));
vi.mock("./ai-model-note", () => ({ AiModelNote: () => null }));

let stored: PlanningSection[];
let nodes: PlanNode[];
function confirmed(id: string): PlanningSection {
  return { ...emptyPlanningSection(id), content: `已决定：${id}`, storyState: "CONFIRMED", version: 1 };
}
function setup(initialItem?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<StrictMode><QueryClientProvider client={client}><ConfirmActionProvider>
    <CreationPreparationView initialItem={initialItem} />
  </ConfirmActionProvider></QueryClientProvider></StrictMode>);
  return client;
}
async function chooseStage(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(title) }));
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.jobs = [];
  stored = [];
  nodes = [];
  mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "雾城来信" });
  mocks.listPlanNodes.mockImplementation(async () => [...nodes]);
  mocks.listPlanningSections.mockImplementation(async () => [...stored]);
  mocks.listModelProfiles.mockResolvedValue([]);
  mocks.listDiscussionSessions.mockResolvedValue([]);
  mocks.listDiscussionMessages.mockResolvedValue([]);
  mocks.getProjectAiTaskOverrides.mockResolvedValue({});
  mocks.savePlanningSection.mockImplementation(async (section: PlanningSection) => {
    const saved = { ...section, version: (section.version ?? 0) + 1 };
    stored = [...stored.filter((item) => item.id !== saved.id), saved];
    return saved;
  });
});
afterEach(cleanup);

describe("creation preparation workbench", () => {
  it.each(["outline", "opening"])("only offers an AI entry for a missing %s on the normal preparation page", async (item) => {
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={new QueryClient()}>
      <CreationPreparationView initialItem={item} />
    </QueryClientProvider></AiWorkspaceContext.Provider>);
    expect(await screen.findByRole("link", { name: /去共创处理/ })).toHaveAttribute("href",
      `/discussion?work=preparation&targetProject=project&item=${item}`);
    expect(screen.queryByRole("button", { name: /发起讨论|建立开篇章节计划|建立主线大纲/ })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.createDiscussionSession).not.toHaveBeenCalled();
  });
  it("keeps formal preparation separate from candidate editing outside the AI workspace", async () => {
    stored = [{ ...confirmed("engine-protagonist"), pendingContent: "尚未采用的人物候选" }];
    render(<AiWorkspaceContext.Provider value={false}><QueryClientProvider client={new QueryClient()}>
      <CreationPreparationView initialItem="protagonist" />
    </QueryClientProvider></AiWorkspaceContext.Provider>);
    expect(await screen.findByText("已决定：engine-protagonist")).toBeVisible();
    expect(screen.getByText("待归类 · 筹备")).toBeVisible();
    expect(screen.queryByText("尚未采用的人物候选")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /AI 推敲|保存草稿|确认并继续/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去共创处理主角/ })).toHaveAttribute("href",
      "/discussion?work=preparation&targetProject=project&item=protagonist");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });
  it("can discuss the outline before prior decisions or an outline node exist", async () => {
    mocks.listModelProfiles.mockResolvedValue([{ id: "model", capability: "CHAT", hasSecret: true }]);
    mocks.createDiscussionSession.mockImplementation(async (input) => {
      const session = { ...input, id: "outline-discussion", projectId: "project" };
      mocks.listDiscussionSessions.mockResolvedValue([session]);
      return session;
    });
    mocks.askProjectDiscussion.mockImplementation(async () => {
      const exchange = {
        userMessage: { id: "user", sessionId: "outline-discussion", role: "USER", content: "我只想先聊故事的中段" },
        assistantMessage: { id: "ai", sessionId: "outline-discussion", role: "ASSISTANT", content: "可以先从中段的一次选择开始。" },
      };
      mocks.listDiscussionMessages.mockResolvedValue([exchange.userMessage, exchange.assistantMessage]);
      return exchange;
    });
    setup("outline");
    fireEvent.click(await screen.findByRole("button", { name: "发起讨论" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "主线大纲的讨论输入" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "主线大纲的讨论输入" }), { target: { value: "我只想先聊故事的中段" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("可以先从中段的一次选择开始。");
    expect(JSON.parse(mocks.createDiscussionSession.mock.calls[0][0].scopeText)).toMatchObject({ sectionId: "preparation:outline" });
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("discusses a preparation item, loads the result as draft, and only confirms on the author's action", async () => {
    mocks.listModelProfiles.mockResolvedValue([{ id: "model", capability: "CHAT", hasSecret: true }]);
    const discussionSession = {
      id: "discussion", projectId: "project", scopeKind: "PROJECT",
      scopeText: JSON.stringify({ kind: "planning-section", sectionId: "seed-premise", title: "故事核心", question: "" }),
    };
    mocks.createDiscussionSession.mockImplementation(async () => {
      mocks.listDiscussionSessions.mockResolvedValue([discussionSession]);
      return discussionSession;
    });
    const answer = "邮差收到未来的来信，但只想把它退回。";
    const exchange = {
      userMessage: { id: "user", sessionId: "discussion", role: "USER", content: "我想从邮差收到一封怪信开始" },
      assistantMessage: { id: "ai", sessionId: "discussion", role: "ASSISTANT", content: answer },
    };
    mocks.askProjectDiscussion.mockImplementation(async () => {
      mocks.listDiscussionMessages.mockResolvedValue([exchange.userMessage, exchange.assistantMessage]);
      return exchange;
    });
    setup();
    await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.click(screen.getByRole("button", { name: "发起讨论" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "故事核心的讨论输入" })).toBeEnabled());
    fireEvent.change(await screen.findByRole("textbox", { name: "故事核心的讨论输入" }),
      { target: { value: "我想从邮差收到一封怪信开始" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "载入草稿" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "载入草稿" }));
    expect(screen.getByRole("textbox", { name: "故事核心" })).toHaveValue(answer);
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(screen.getByText("关键准备 0 / 10")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("textbox", { name: "题材" });
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-premise", content: answer, pendingContent: "", storyState: "CONFIRMED",
    }));
  });

  it("starts with story decisions, not chapter creation, and makes no writes on mount", async () => {
    setup();
    expect(await screen.findByRole("textbox", { name: "故事核心" })).toBeVisible();
    expect(screen.getByText("关键准备 0 / 10")).toBeVisible();
    expect(screen.queryByRole("link", { name: "进入正文" })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
  });

  it("saves drafts separately without advancing progress or changing formal content", async () => {
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "一个收到未来来信的邮差。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-premise", content: "", pendingContent: "一个收到未来来信的邮差。", storyState: "UNSET", version: 0,
    }));
    expect(input).toHaveValue("一个收到未来来信的邮差。");
    expect(screen.getByText("关键准备 0 / 10")).toBeVisible();
  });

  it("confirms the author's text using the stored version and advances to the next decision", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), pendingContent: "收到未来来信的邮差", version: 4 }];
    setup();
    expect(await screen.findByRole("textbox", { name: "故事核心" })).toHaveValue("收到未来来信的邮差");
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(await screen.findByRole("textbox", { name: "题材" })).toBeVisible();
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-premise", content: "收到未来来信的邮差", pendingContent: "", storyState: "CONFIRMED", version: 4,
    }));
    expect(screen.getByText("关键准备 1 / 10")).toBeVisible();
  });

  it("preserves input after a failed save and does not advance", async () => {
    mocks.savePlanningSection.mockRejectedValue(new Error("磁盘不可写"));
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "尚未保存的核心" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘不可写");
    expect(input).toHaveValue("尚未保存的核心");
    expect(screen.getByText("关键准备 0 / 10")).toBeVisible();
  });

  it("confirms genre, reader expectation, protagonist and motivation one at a time", async () => {
    stored = [confirmed("seed-premise")];
    setup();
    const decisions = [
      { title: "题材", question: "你想写什么题材？", value: "都市悬疑", sectionId: "seed-genre" },
      { title: "阅读期待", question: "你最想让读者感受到什么？", value: "逐渐接近真相的紧张感", sectionId: "seed-genre-promise" },
      { title: "主角", question: "主角是个怎样的人？", value: "一位谨慎的邮差", sectionId: "engine-protagonist" },
      { title: "行动动机", question: "什么让主角必须行动？", value: "寻找失踪的妹妹", sectionId: "engine-motivation" },
    ];
    for (const [index, decision] of decisions.entries()) {
      const input = await screen.findByRole("textbox", { name: decision.title });
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(screen.getByText(decision.question)).toBeVisible();
      expect(input.getAttribute("placeholder")).not.toContain("\n");
      fireEvent.change(input, { target: { value: decision.value } });
      fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
      await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledTimes(index + 1));
      expect(mocks.savePlanningSection).toHaveBeenLastCalledWith(expect.objectContaining({
        id: decision.sectionId, content: decision.value, pendingContent: "", storyState: "CONFIRMED",
      }));
    }
    expect(await screen.findByRole("textbox", { name: "故事规则" })).toBeVisible();
    expect(screen.getByText("关键准备 5 / 10")).toBeVisible();
  });

  it("keeps existing combined notes intact without guessing or confirming new split decisions", async () => {
    const combinedPromise = { ...confirmed("seed-genre-promise"), content: "都市悬疑，让读者逐渐接近真相。" };
    const combinedProtagonist = { ...confirmed("engine-protagonist"), content: "林舟是邮差，必须找到失踪的妹妹。" };
    stored = [confirmed("seed-premise"), combinedPromise, combinedProtagonist];
    setup();
    expect(await screen.findByRole("textbox", { name: "题材" })).toHaveValue("");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(stored.find((section) => section.id === "seed-genre-promise")).toEqual(combinedPromise);
    expect(stored.find((section) => section.id === "engine-protagonist")).toEqual(combinedProtagonist);
    expect(screen.getByText(combinedPromise.content)).toBeInTheDocument();
    expect(screen.getByText(combinedProtagonist.content)).toBeInTheDocument();
    expect(stored.some((section) => section.id === "seed-genre" || section.id === "engine-motivation")).toBe(false);
  });

  it("cancels switching without losing dirty input", async () => {
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "我正在推敲" } });
    await chooseStage("建立关键设定");
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("我正在推敲");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("shows a single outline review item and lets the author return to a previous item", async () => {
    outlineSetup();
    setup("outline");
    fireEvent.change(await screen.findByRole("textbox", { name: "主线大纲" }), { target: { value: "主角收到来信后决定追查寄信人。" } });
    const review = screen.getByRole("region", { name: "作者审阅" });
    expect(within(review).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(review).getByRole("checkbox", { name: outlineReviewChecks[0] })).not.toBeChecked();
    expect(within(review).getByRole("textbox", { name: "待定问题与取舍" })).not.toBeVisible();
    fireEvent.click(within(review).getByRole("checkbox"));
    expect(within(review).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(review).getByRole("checkbox", { name: outlineReviewChecks[1] })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    fireEvent.click(within(review).getByRole("button", { name: "上一条" }));
    expect(within(review).getByRole("checkbox", { name: outlineReviewChecks[0] })).not.toBeChecked();
    for (const check of outlineReviewChecks) fireEvent.click(within(review).getByRole("checkbox", { name: check }));
    expect(within(review).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(review).getByText("本轮审阅完成")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeEnabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("shows missing prerequisites and prevents early chapter or outline creation", async () => {
    setup();
    await chooseStage("准备开篇");
    expect(screen.getByRole("button", { name: "建立开篇章节计划" })).toBeDisabled();
    expect(screen.getByText("前序关键准备尚有 9 项待确认")).toBeVisible();
    await chooseStage("审定主线大纲");
    expect(screen.getByRole("button", { name: "建立主线大纲" })).toBeDisabled();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("reuses legacy unconfirmed notes without calling them confirmed or hiding them", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), content: "以前写下的前提", version: 2 }];
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    expect(input).toHaveValue("以前写下的前提");
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("textbox", { name: "题材" });
    expect(stored.find((section) => section.id === "seed-premise")?.storyState).toBe("CONFIRMED");
  });

  it("keeps previously confirmed content while revising in a separate draft", async () => {
    stored = [confirmed("seed-premise")];
    setup();
    await screen.findByRole("textbox", { name: "题材" });
    fireEvent.click(screen.getByRole("button", { name: /故事核心/ }));
    expect(await screen.findByRole("textbox", { name: "故事核心" })).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "修订草稿" }));
    fireEvent.change(screen.getByRole("textbox", { name: "故事核心" }), { target: { value: "新的前提" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    expect(stored.find((section) => section.id === "seed-premise")).toMatchObject({
      content: "已决定：seed-premise", pendingContent: "新的前提", storyState: "CONFIRMED",
    });
    expect(screen.getByText("关键准备 0 / 10")).toBeVisible();
  });

  it("records optional deferrals without inventing confirmed facts", async () => {
    setup();
    await chooseStage("建立关键设定");
    fireEvent.click(screen.getByRole("button", { name: /关键关系/ }));
    fireEvent.click(screen.getByRole("button", { name: "暂不决定" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "cast-core-relationship", storyState: "DEFERRED", content: "",
    })));
  });

  it("offers writing only after each key decision has been confirmed", async () => {
    nodes = [
      { id: "outline", kind: "OUTLINE", title: "大纲", parentId: null, archived: false, revision: 1, sortOrder: 0 },
      { id: "first", kind: "CHAPTER", title: "第一章", parentId: "volume", archived: false, revision: 1, sortOrder: 0 },
    ];
    stored = buildPreparationStages(nodes).flatMap((stage) => stage.items).filter((item) => item.required).map((item) => confirmed(item.sectionId!));
    setup();
    expect(await screen.findByRole("link", { name: "进入正文" })).toHaveAttribute("href", "/writing#first");
    expect(screen.getByText("关键准备 10 / 10")).toBeVisible();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("does not edit or overwrite locked decisions", async () => {
    stored = [{ ...confirmed("seed-premise"), storyState: "LOCKED" }];
    setup();
    await screen.findByRole("textbox", { name: "题材" });
    fireEvent.click(screen.getByRole("button", { name: /故事核心/ }));
    expect(screen.getByRole("textbox", { name: "故事核心" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "修订草稿" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeDisabled();
  });

  it("retains local input when AI finishes remotely, requiring an explicit reload", async () => {
    const client = setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "本地输入" } });
    act(() => client.setQueryData(["planning-sections"], [{
      ...emptyPlanningSection("seed-premise"), pendingContent: "远端生成稿", storyState: "AI_SUGGESTED", version: 1,
    }]));
    expect(input).toHaveValue("本地输入");
    fireEvent.click(await screen.findByRole("button", { name: "读取最新内容" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("本地输入");
  });

  it("rejects stale discard approval when the author edits during confirmation", async () => {
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "原输入" } });
    await chooseStage("建立关键设定");
    fireEvent.change(input, { target: { value: "确认期间的新输入" } });
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并切换" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("确认期间准备内容已变化");
    expect(input).toHaveValue("确认期间的新输入");
  });

  it("prevents switching and duplicate submissions during a pending save", async () => {
    let finish!: (section: PlanningSection) => void;
    mocks.savePlanningSection.mockImplementationOnce(() => new Promise<PlanningSection>((resolve) => { finish = resolve; }));
    setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "故事核心" }), { target: { value: "确认中" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(screen.getByRole("button", { name: /建立关键设定/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(mocks.savePlanningSection).toHaveBeenCalledOnce();
    await act(async () => finish({ ...confirmed("seed-premise"), content: "确认中" }));
    expect(await screen.findByRole("textbox", { name: "题材" })).toBeVisible();
  });

  it("generates only on explicit request, using confirmed context and keeping the task a draft", async () => {
    const base = confirmed("frame-setting");
    stored = [base, { ...emptyPlanningSection("engine-stakes"), content: "未确认的代价", storyState: "AI_SUGGESTED" }];
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    mocks.enqueuePlanningAiJob.mockResolvedValue({});
    setup();
    await screen.findByRole("textbox", { name: "故事核心" });
    const button = screen.getByRole("button", { name: "AI 推敲讨论稿" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: "seed-premise", profileId: "chat", taskKey: "workDesign", mode: "GENERATE",
      existingContext: `[设定 · 世界规则与限制] frame-setting: ${base.content}`,
    })));
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(screen.getByText("关键准备 1 / 10")).toBeVisible();
  });

  it("requires approval before AI replaces a saved candidate and cancels without submitting", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), pendingContent: "保存过的讨论稿", storyState: "AI_SUGGESTED" }];
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    setup();
    await screen.findByRole("textbox", { name: "故事核心" });
    const button = screen.getByRole("button", { name: "AI 推敲讨论稿" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("替换当前已保存的讨论稿");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "故事核心" })).toHaveValue("保存过的讨论稿");
  });

  it.each([
    { initial: "premise", title: "故事核心", id: "seed-premise", taskKey: "workDesign" },
    { initial: "outline", title: "引发事件", id: "outline-step-outline-inciting", taskKey: "outline" },
  ])("saves the current $title input before submitting one scoped AI task", async ({ initial, title, id, taskKey }) => {
    if (initial === "outline") outlineSetup(false);
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    setup(initial);
    const input = await screen.findByRole("textbox", { name: title });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "来自妹妹的来信让主角决定追查。" } });
    const generate = screen.getByRole("button", { name: "保存并推敲" });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    await screen.findByText("讨论稿任务已提交");
    expect(mocks.savePlanningSection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id, content: "", pendingContent: "来自妹妹的来信让主角决定追查。", storyState: "UNSET", version: 0,
    }));
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sectionId: id, taskKey, userGuidance: expect.stringContaining("作者当前草稿（尚未确认）：\n来自妹妹的来信让主角决定追查。"),
    }));
    expect(mocks.savePlanningSection.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueuePlanningAiJob.mock.invocationCallOrder[0]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(input).toHaveValue("来自妹妹的来信让主角决定追查。");
    expect(stored.find((section) => section.id === id)?.storyState).toBe("UNSET");
  });

  it("does not save or generate until replacement is approved and keeps the formal outline intact", async () => {
    outlineSetup(false);
    stored.push({ ...confirmed("plan-node:outline"), content: "原正式主线", pendingContent: "已保存的讨论稿", version: 7, references: ["discussion:original"] });
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    setup("outline");
    const input = await screen.findByRole("textbox", { name: "主线大纲" });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "根据新想法修改的主线" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    expect(input).toHaveValue("根据新想法修改的主线");
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "重新推敲" }));
    await screen.findByText("讨论稿任务已提交");
    expect(stored.find((section) => section.id === "plan-node:outline")).toMatchObject({
      content: "原正式主线", pendingContent: "根据新想法修改的主线", version: 8, references: ["discussion:original"],
    });
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sectionId: "plan-node:outline", referenceContent: "原正式主线\n\n根据新想法修改的主线",
    }));
  });

  it("keeps unsaved input after an autosave conflict and never submits AI before a successful retry", async () => {
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    mocks.savePlanningSection.mockRejectedValueOnce(new Error("版本冲突"));
    setup("premise");
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "不能丢失的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(input).toHaveValue("不能丢失的想法");
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存并推敲" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    await screen.findByText("讨论稿任务已提交");
    expect(mocks.savePlanningSection).toHaveBeenCalledTimes(2);
    expect(mocks.savePlanningSection.mock.calls.map(([section]) => section.version)).toEqual([0, 0]);
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledOnce();
  });

  it("keeps the saved draft after queue failure and retries without saving it twice", async () => {
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    mocks.enqueuePlanningAiJob.mockRejectedValueOnce(new Error("队列不可用")).mockResolvedValueOnce({});
    setup("premise");
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "已经写下的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("队列不可用");
    expect(screen.getByText("草稿已保存")).toBeVisible();
    expect(input).toHaveValue("已经写下的想法");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "AI 推敲讨论稿" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "重新推敲" }));
    await screen.findByText("讨论稿任务已提交");
    expect(mocks.savePlanningSection).toHaveBeenCalledOnce();
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledTimes(2);
    expect(stored[0]).toMatchObject({ content: "", pendingContent: "已经写下的想法", storyState: "UNSET", version: 1 });
  });

  it("prevents duplicate submissions while saving and preserves edits made during that save", async () => {
    let finish!: () => void;
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    mocks.savePlanningSection.mockImplementationOnce((section: PlanningSection) => new Promise((resolve) => {
      finish = () => { const saved = { ...section, version: 1 }; stored = [saved]; resolve(saved); };
    }));
    setup("premise");
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "提交保存的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: /建立关键设定/ })).toBeDisabled();
    const saving = screen.getByRole("button", { name: "保存中…" });
    expect(saving).toBeDisabled();
    fireEvent.click(saving);
    expect(mocks.savePlanningSection).toHaveBeenCalledOnce();
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "保存期间的新想法" } });
    await act(async () => finish());
    expect(await screen.findByRole("alert")).toHaveTextContent("保存期间内容已变化");
    expect(input).toHaveValue("保存期间的新想法");
    expect(stored[0].pendingContent).toBe("提交保存的想法");
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存并推敲" })).toBeEnabled();
  });

  it("rejects replacement approval if the draft changes while confirmation is open", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), pendingContent: "旧讨论稿", version: 3 }];
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    setup("premise");
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "第一次修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    await screen.findByRole("alertdialog");
    fireEvent.change(input, { target: { value: "确认期间的新修改" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "重新推敲" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("确认期间准备内容已变化");
    expect(input).toHaveValue("确认期间的新修改");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
  });

  it("does not enqueue a saved outline event if the author locks the main outline during autosave", async () => {
    outlineSetup(false);
    let finish!: () => void;
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    mocks.savePlanningSection.mockImplementationOnce((section: PlanningSection) => new Promise((resolve) => {
      finish = () => { const saved = { ...section, version: 1 }; stored.push(saved); resolve(saved); };
    }));
    const client = setup("outline");
    const input = await screen.findByRole("textbox", { name: "引发事件" });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "需要继续推敲的起因" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并推敲" }));
    stored.push({ ...confirmed("plan-node:outline"), storyState: "LOCKED" });
    act(() => client.setQueryData(["planning-sections"], [...stored]));
    await waitFor(() => expect(input).toHaveAttribute("readonly"));
    await act(async () => finish());
    expect(await screen.findByRole("alert")).toHaveTextContent("当前内容状态已变化");
    expect(input).toHaveValue("需要继续推敲的起因");
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    expect(stored.find((section) => section.id === "outline-step-outline-inciting")?.pendingContent).toBe("需要继续推敲的起因");
  });

  it("does not auto-switch away from dirty input when remote progress changes", async () => {
    const client = setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "本地仍在编辑" } });
    act(() => client.setQueryData(["planning-sections"], [confirmed("seed-premise")]));
    await waitFor(() => expect(screen.getByText("关键准备 1 / 10")).toBeVisible());
    expect(input).toHaveValue("本地仍在编辑");
    expect(screen.queryByRole("textbox", { name: "题材" })).not.toBeInTheDocument();
  });

  function outlineSetup(legacyDraft = true) {
    nodes = [{ id: "outline", kind: "OUTLINE", title: "主线大纲", parentId: null, archived: false, revision: 1, sortOrder: 0 }];
    stored = buildPreparationStages(nodes).slice(0, 2).flatMap((stage) => stage.items).filter((item) => item.required).map((item) => confirmed(item.sectionId!));
    if (legacyDraft) stored.push({ ...emptyPlanningSection("plan-node:outline"), pendingContent: "以前写下的主线草稿" });
  }

  it("develops one outline event at a time and only assembles after all five are confirmed", async () => {
    outlineSetup(false);
    setup("outline");
    const steps = buildOutlineSteps("plan-node:outline");
    expect(await screen.findByRole("textbox", { name: steps[0].title })).toHaveValue("");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    for (const [index, step] of steps.entries()) {
      const input = await screen.findByRole("textbox", { name: step.title });
      expect(screen.getByText(step.question)).toBeVisible();
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      fireEvent.change(input, { target: { value: `第 ${index + 1} 段具体情节` } });
      fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
      await waitFor(() => expect(stored.find((section) => section.id === step.sectionId)?.storyState).toBe("CONFIRMED"));
      expect(stored.some((section) => section.id === "plan-node:outline")).toBe(false);
    }
    const mainInput = await screen.findByRole("textbox", { name: "主线大纲" });
    expect(screen.getByText("情节确认 5 / 5")).toBeVisible();
    expect(screen.queryByRole("button", { name: "AI 推敲讨论稿" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "汇总为大纲草稿" }));
    await waitFor(() => expect(mainInput).toHaveValue(assembleOutline(steps, stored)));
    const main = stored.find((section) => section.id === "plan-node:outline")!;
    expect(main.content).toBe("");
    expect(main.storyState).toBe("UNSET");
    expect(screen.getByText("关键准备 8 / 10")).toBeVisible();
    outlineReviewChecks.forEach((check) => fireEvent.click(screen.getByRole("checkbox", { name: check })));
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("textbox", { name: "结局方向" });
    const formal = stored.find((section) => section.id === "plan-node:outline")!;
    expect(formal.content).toBe(assembleOutline(steps, stored));
    expect(readPlanningReview(formal)?.basis).toHaveLength(13);
  });

  it("keeps unfinished events on their own drafts and blocks skipping their causal prerequisites", async () => {
    outlineSetup(false);
    const client = setup("outline");
    const first = await screen.findByRole("textbox", { name: "引发事件" });
    fireEvent.change(first, { target: { value: "尚未确定的起因" } });
    fireEvent.click(screen.getByRole("button", { name: "冲突升级" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(first).toHaveValue("尚未确定的起因");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    fireEvent.click(screen.getByRole("button", { name: "冲突升级" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "冲突升级" }), { target: { value: "新困难" } });
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    expect(screen.getByText("前序关键准备尚有 2 项待确认")).toBeVisible();
    expect(stored[stored.length - 1]).toMatchObject({ content: "", pendingContent: "尚未确定的起因", storyState: "UNSET" });
    cleanup();
    render(<QueryClientProvider client={client}><ConfirmActionProvider><CreationPreparationView initialItem="outline" /></ConfirmActionProvider></QueryClientProvider>);
    expect(await screen.findByRole("textbox", { name: "引发事件" })).toHaveValue("尚未确定的起因");
  });

  it("scopes AI to the current event and includes preceding confirmed events without generating the whole outline", async () => {
    outlineSetup(false);
    const steps = buildOutlineSteps("plan-node:outline");
    stored.push({ ...confirmed(steps[0].sectionId!), content: "妹妹的来信打破平静" });
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    setup("outline");
    await screen.findByRole("textbox", { name: "初次行动" });
    const generate = screen.getByRole("button", { name: "AI 推敲讨论稿" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledOnce());
    const input = mocks.enqueuePlanningAiJob.mock.calls[0][0];
    expect(input).toMatchObject({ sectionId: steps[1].sectionId, taskKey: "outline" });
    expect(input.sectionPrompt).toContain("主角的具体目标");
    expect(input.sectionPrompt).toContain("行动缘由");
    expect(input.existingContext).toContain("妹妹的来信打破平静");
    expect(input.userGuidance).toContain("不生成整份大纲");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("preserves legacy outlines, requires approval to replace their candidates and saves assembled text only as a draft", async () => {
    outlineSetup(false);
    const steps = buildOutlineSteps("plan-node:outline");
    stored.push(...steps.map((step) => confirmed(step.sectionId!)), {
      ...confirmed("plan-node:outline"), content: "原正式主线", pendingContent: "作者修订稿", version: 7, references: ["discussion:original"],
    });
    setup("outline");
    const main = await screen.findByRole("textbox", { name: "主线大纲" });
    expect(main).toHaveValue("作者修订稿");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "汇总为大纲草稿" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(main).toHaveValue("作者修订稿");
    fireEvent.click(screen.getByRole("button", { name: "汇总为大纲草稿" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "重新汇总" }));
    await waitFor(() => expect(main).toHaveValue(assembleOutline(steps, stored)));
    expect(stored.find((section) => section.id === "plan-node:outline")).toMatchObject({
      content: "原正式主线", pendingContent: assembleOutline(steps, stored), version: 8,
      references: expect.arrayContaining(["discussion:original"]),
    });
  });

  it("blocks confirmation of an assembled outline when one of its source events changes", async () => {
    outlineSetup(false);
    const steps = buildOutlineSteps("plan-node:outline");
    stored.push(...steps.map((step) => confirmed(step.sectionId!)), {
      ...emptyPlanningSection("plan-node:outline"), pendingContent: "汇总稿",
      references: withOutlineSources([], steps, steps.map((step) => confirmed(step.sectionId!))),
    });
    const client = setup("outline");
    await screen.findByRole("textbox", { name: "主线大纲" });
    outlineReviewChecks.forEach((check) => fireEvent.click(screen.getByRole("checkbox", { name: check })));
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeEnabled();
    act(() => client.setQueryData(["planning-sections"], stored.map((section) => section.id === steps[0].sectionId ? { ...section, content: "不同的引发事件", version: 2 } : section)));
    expect(await screen.findByText("情节已修改，请重新汇总大纲。")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "主线大纲" })).toHaveValue("汇总稿");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing formal outline when saving or confirming a new event", async () => {
    outlineSetup(false);
    stored.push({ ...confirmed("plan-node:outline"), content: "旧大纲原文" });
    setup("outline");
    expect(await screen.findByRole("textbox", { name: "主线大纲" })).toHaveValue("旧大纲原文");
    fireEvent.click(screen.getByRole("button", { name: "引发事件" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "引发事件" }), { target: { value: "新的起因" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("textbox", { name: "初次行动" });
    expect(stored.find((section) => section.id === "plan-node:outline")?.content).toBe("旧大纲原文");
    expect(mocks.savePlanningSection).toHaveBeenCalledOnce();
  });

  it("keeps an event draft after a failed save and prevents accidental lock bypass", async () => {
    outlineSetup(false);
    mocks.savePlanningSection.mockRejectedValue(new Error("保存失败"));
    const client = setup("outline");
    fireEvent.change(await screen.findByRole("textbox", { name: "引发事件" }), { target: { value: "新的起因" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("textbox", { name: "引发事件" })).toHaveValue("新的起因");
    act(() => client.setQueryData(["planning-sections"], [...stored, { ...confirmed("plan-node:outline"), storyState: "LOCKED" }]));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "引发事件" })).toHaveAttribute("readonly"));
    expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "继续下一项" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "解除锁定" })).not.toBeInTheDocument();
  });

  it("locks assembly to one request and preserves both formal and candidate text after failure", async () => {
    outlineSetup(false);
    const steps = buildOutlineSteps("plan-node:outline");
    stored.push(...steps.map((step) => confirmed(step.sectionId!)), {
      ...confirmed("plan-node:outline"), content: "原正式内容", pendingContent: "保留的修订稿", version: 4,
    });
    let reject!: (error: Error) => void;
    mocks.savePlanningSection.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    setup("outline");
    await screen.findByRole("textbox", { name: "主线大纲" });
    fireEvent.click(screen.getByRole("button", { name: "汇总为大纲草稿" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "重新汇总" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "主线大纲" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "引发事件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /建立关键设定/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "汇总中…" }));
    expect(mocks.savePlanningSection).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("版本冲突")));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(screen.getByRole("textbox", { name: "主线大纲" })).toHaveValue("保留的修订稿");
    expect(stored.find((section) => section.id === "plan-node:outline")).toMatchObject({ content: "原正式内容", pendingContent: "保留的修订稿", version: 4 });
    expect(screen.getByRole("button", { name: "汇总为大纲草稿" })).toBeEnabled();
  });

  it("rejects an assembly approval after its source events change during confirmation", async () => {
    outlineSetup(false);
    const steps = buildOutlineSteps("plan-node:outline");
    stored.push(...steps.map((step) => confirmed(step.sectionId!)), {
      ...emptyPlanningSection("plan-node:outline"), pendingContent: "旧修订稿", version: 2,
      references: withOutlineSources([], steps, steps.map((step) => confirmed(step.sectionId!))),
    });
    const client = setup("outline");
    await screen.findByRole("textbox", { name: "主线大纲" });
    fireEvent.click(screen.getByRole("button", { name: "汇总为大纲草稿" }));
    await screen.findByRole("alertdialog");
    act(() => client.setQueryData(["planning-sections"], stored.map((section) => section.id === steps[0].sectionId ? { ...section, version: 2 } : section)));
    await screen.findByText("情节已修改，请重新汇总大纲。");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "重新汇总" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("情节已有更新");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "主线大纲" })).toHaveValue("旧修订稿");
  });

  it.each(["plan-node:outline", "outline-step-outline-inciting"])("waits for active AI work before assembling or confirming: %s", async (sectionId) => {
    outlineSetup(false);
    const steps = buildOutlineSteps("plan-node:outline");
    stored.push(...steps.map((step) => confirmed(step.sectionId!)), {
      ...emptyPlanningSection("plan-node:outline"), pendingContent: "已保存的汇总草稿",
    });
    mocks.jobs = [{ id: "job", status: "RUNNING", progress: 40, jobType: "AI_PLANNING_GENERATE", payload: JSON.stringify({ sectionId }) }];
    setup("outline");
    await screen.findByRole("textbox", { name: "主线大纲" });
    expect(screen.getByText("大纲情节仍在推敲中")).toBeVisible();
    expect(screen.getByRole("button", { name: "汇总为大纲草稿" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("requires all outline review decisions and resets them when the text changes", async () => {
    outlineSetup();
    setup("outline");
    const input = await screen.findByRole("textbox", { name: "主线大纲" });
    fireEvent.change(input, { target: { value: "诱因、选择、升级、转折与收束" } });
    const accept = screen.getByRole("button", { name: "确认并继续" });
    expect(accept).toBeDisabled();
    outlineReviewChecks.forEach((check) => fireEvent.click(screen.getByRole("checkbox", { name: check })));
    expect(accept).toBeEnabled();
    fireEvent.change(input, { target: { value: "改为另一条因果主线" } });
    expect(accept).toBeDisabled();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: outlineReviewChecks[0] })).not.toBeChecked();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("persists author review, source versions and open questions only on explicit confirmation", async () => {
    outlineSetup(false);
    stored.push({ ...emptyPlanningSection("plan-node:outline"), pendingContent: "早期草稿", references: ["discussion:original"], version: 2 });
    setup("outline");
    fireEvent.change(await screen.findByRole("textbox", { name: "主线大纲" }), { target: { value: "主角失信后选择承担代价，完成阶段目标。" } });
    fireEvent.click(screen.getByText("待定问题与取舍"));
    fireEvent.change(screen.getByRole("textbox", { name: "待定问题与取舍" }), { target: { value: "终局真相保留两个备选。" } });
    outlineReviewChecks.forEach((check) => fireEvent.click(screen.getByRole("checkbox", { name: check })));
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("textbox", { name: "结局方向" });
    const section = stored.find((section) => section.id === "plan-node:outline")!;
    expect(section).toMatchObject({ version: 3, consequence: "终局真相保留两个备选。", pendingContent: "", storyState: "CONFIRMED" });
    expect(section.references).toContain("discussion:original");
    expect(readPlanningReview(section)).toMatchObject({ sectionVersion: 3, checks: outlineReviewChecks });
    expect(readPlanningReview(section)?.basis).toHaveLength(8);
  });

  it("preserves a formal outline and requests re-review after an upstream revision", async () => {
    outlineSetup(false);
    const previous = { ...confirmed("plan-node:outline"), content: "原来审定的主线", version: 1 };
    stored.push({ ...previous, references: withPlanningReview(previous, outlineReviewChecks, [...stored]), version: 2 });
    const client = setup("outline");
    const input = await screen.findByRole("textbox", { name: "主线大纲" });
    expect(input).toHaveAttribute("readonly");
    const updated = stored.map((section) => section.id === "seed-premise" ? { ...section, content: "新的故事核心", version: 2 } : section);
    act(() => client.setQueryData(["planning-sections"], updated));
    expect(await screen.findByText(/确认依据已有变化/)).toHaveTextContent("故事核心");
    expect(input).toHaveValue("原来审定的主线");
    expect(screen.getByText("关键准备 8 / 10")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("does not bypass outline prerequisites even after every review box is checked", async () => {
    outlineSetup();
    stored = [{ ...emptyPlanningSection("plan-node:outline"), pendingContent: "早期草稿" }];
    setup("outline");
    fireEvent.change(await screen.findByRole("textbox", { name: "主线大纲" }), { target: { value: "临时大纲草稿" } });
    outlineReviewChecks.forEach((check) => fireEvent.click(screen.getByRole("checkbox", { name: check })));
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    expect(stored[0]).toMatchObject({ content: "", pendingContent: "临时大纲草稿", storyState: "UNSET", references: [] });
  });

  it("reviews the opening chapter against the confirmed story and outline before writing", async () => {
    outlineSetup(false);
    nodes.push({ id: "first", kind: "CHAPTER", title: "第一章", parentId: "volume", archived: false, revision: 1, sortOrder: 0 });
    stored.push(confirmed("plan-node:outline"));
    setup("opening");
    fireEvent.change(await screen.findByRole("textbox", { name: "开篇章节计划" }), { target: { value: "收信后隐瞒线索，导致监察员跟踪。" } });
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeDisabled();
    openingReviewChecks.forEach((check) => fireEvent.click(screen.getByRole("checkbox", { name: check })));
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("link", { name: "进入正文" });
    expect(readPlanningReview(stored.find((section) => section.id === "plan-node:first"))?.basis).toEqual(expect.arrayContaining([
      { id: "plan-node:outline", version: 1 },
    ]));
  });

  it("retains a previously saved draft after a confirmation conflict and a remote refresh", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), pendingContent: "作者保存过的草稿", version: 2 }];
    mocks.savePlanningSection.mockRejectedValue(new Error("版本冲突"));
    const client = setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("alert");
    act(() => client.setQueryData(["planning-sections"], [{ ...stored[0], pendingContent: "其他来源的新稿", version: 3 }]));
    expect(input).toHaveValue("作者保存过的草稿");
    expect(await screen.findByRole("button", { name: "读取最新内容" })).toBeVisible();
  });

  it("requires explicit approval to unlock and preserves the formal content", async () => {
    stored = [{ ...confirmed("seed-premise"), storyState: "LOCKED" }];
    setup("premise");
    await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.click(screen.getByRole("button", { name: "解除锁定" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "解除锁定" }));
    await screen.findByRole("button", { name: "修订草稿" });
    expect(stored[0]).toMatchObject({ content: "已决定：seed-premise", storyState: "CONFIRMED", pendingContent: "" });
    expect(screen.getByRole("textbox", { name: "故事核心" })).toHaveAttribute("readonly");
  });
});
