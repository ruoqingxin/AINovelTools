import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscussionMessage, DiscussionSession } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { PlanningSectionDiscussion } from "./planning-section-discussion";

const mocks = vi.hoisted(() => ({
  getCurrentProject: vi.fn(), listDiscussionSessions: vi.fn(), listDiscussionMessages: vi.fn(),
  createDiscussionSession: vi.fn(), askProjectDiscussion: vi.fn(), listModelProfiles: vi.fn(),
  getProjectAiTaskOverrides: vi.fn(), savePlanningSection: vi.fn(), onUseDraft: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {}, isPending: false }),
}));
vi.mock("./ai-model-note", () => ({ AiModelNote: () => null }));

let sessions: DiscussionSession[];
let history: DiscussionMessage[];
function session(sectionId = "seed-premise", projectId = "project"): DiscussionSession {
  return { id: `session-${sectionId}`, projectId, scopeKind: "PROJECT", scopeId: null,
    scopeText: JSON.stringify({ kind: "planning-section", sectionId, title: "故事核心", question: "从哪里开始？" }),
    title: "故事核心讨论", summary: "", createdAt: "", updatedAt: "" };
}
function message(id: string, role: "USER" | "ASSISTANT", content: string, sessionId = "session-seed-premise"): DiscussionMessage {
  return { id, role, content, sessionId, createdAt: "", profileId: null, contextVersion: null, contextSummary: null };
}
function setup(extra: Partial<Parameters<typeof PlanningSectionDiscussion>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { sectionId: "seed-premise", title: "故事核心", question: "从哪里开始？",
    draftContent: "", onUseDraft: mocks.onUseDraft, ...extra };
  const tree = (next = props) => <StrictMode><QueryClientProvider client={client}><ConfirmActionProvider>
    <PlanningSectionDiscussion {...next} />
  </ConfirmActionProvider></QueryClientProvider></StrictMode>;
  const view = render(tree());
  return { client, rerender: (next: Partial<typeof props>) => view.rerender(tree({ ...props, ...next })) };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "发起讨论" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "故事核心的讨论输入" })).toBeEnabled());
}
async function send(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "故事核心的讨论输入" }), { target: { value: text } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessions = [];
  history = [];
  mocks.getCurrentProject.mockResolvedValue({ projectId: "project" });
  mocks.listDiscussionSessions.mockImplementation(async () => [...sessions]);
  mocks.listDiscussionMessages.mockImplementation(async (id: string) => history.filter((entry) => entry.sessionId === id));
  mocks.listModelProfiles.mockResolvedValue([{ id: "model", capability: "CHAT", hasSecret: true }]);
  mocks.getProjectAiTaskOverrides.mockResolvedValue({});
  mocks.createDiscussionSession.mockImplementation(async (input) => {
    const created = { ...session(), ...input };
    sessions.push(created);
    return created;
  });
  mocks.askProjectDiscussion.mockImplementation(async (input) => {
    const userMessage = message(`user-${history.length}`, "USER", input.message, input.sessionId);
    const assistantMessage = message(`ai-${history.length}`, "ASSISTANT", `回应：${input.message}`, input.sessionId);
    history.push(userMessage, assistantMessage);
    return { userMessage, assistantMessage };
  });
});
afterEach(cleanup);

describe("per-section planning conversations", () => {
  it("shows the saved context sources separately from the assistant reply", async () => {
    sessions = [session()];
    history = [{ ...message("grounded", "ASSISTANT", "可以让这次使用付出更具体的代价。"),
      contextSummary: "本轮参考（按话题选取，不代表读取全书）：\n当前正文「渡河」\n作者确认规则「魂灯」" }];
    setup();
    await open();
    const summary = await screen.findByText("本轮参考", { selector: "summary" });
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(within(details).getByText(/当前正文「渡河」/)).toBeVisible();
    expect(mocks.onUseDraft).not.toHaveBeenCalled();
  });

  it("does not create sessions, request discussion history, or save settings on mount", () => {
    setup();
    expect(screen.getByRole("button", { name: "发起讨论" })).toBeVisible();
    expect(mocks.listDiscussionSessions).not.toHaveBeenCalled();
    expect(mocks.createDiscussionSession).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("supports multiple turns in one focused session without confirming settings", async () => {
    setup();
    await open();
    await send("我想写一个失忆的邮差");
    await screen.findByText("回应：我想写一个失忆的邮差");
    await send("不要失忆，改成他不愿提起过去");
    await screen.findByText("回应：不要失忆，改成他不愿提起过去");
    expect(mocks.createDiscussionSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.createDiscussionSession.mock.calls[0][0].scopeText)).toMatchObject({
      kind: "planning-section", sectionId: "seed-premise", title: "故事核心",
    });
    expect(mocks.askProjectDiscussion.mock.calls.map(([input]) => input.sessionId)).toEqual(["session-seed-premise", "session-seed-premise"]);
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.onUseDraft).not.toHaveBeenCalled();
  });

  it("resumes only the matching section in the current project", async () => {
    sessions = [session("seed-premise", "other-project"), session("engine-protagonist"), session()];
    history = [message("old", "ASSISTANT", "上次聊到他不愿提起过去")];
    setup();
    await open();
    await screen.findByText("上次聊到他不愿提起过去");
    await send("继续说说这会造成什么冲突");
    await screen.findByText("回应：继续说说这会造成什么冲突");
    expect(mocks.createDiscussionSession).not.toHaveBeenCalled();
  });

  it("only loads a selected reply into the editable draft", async () => {
    sessions = [session()];
    history = [message("answer", "ASSISTANT", "邮差不能说出寄信人的名字")];
    setup();
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "载入草稿" }));
    expect(mocks.onUseDraft).toHaveBeenCalledWith("邮差不能说出寄信人的名字");
    expect(screen.getByText("已载入草稿，尚未确认为正式内容")).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("preserves the existing draft when replacement is cancelled", async () => {
    sessions = [session()];
    history = [message("answer", "ASSISTANT", "新的方向")];
    setup({ draftContent: "我的未保存草稿" });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "载入草稿" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(mocks.onUseDraft).not.toHaveBeenCalled();
  });

  it("does not overwrite draft edits made while replacement confirmation is open", async () => {
    sessions = [session()];
    history = [message("answer", "ASSISTANT", "新的方向")];
    const view = setup({ draftContent: "旧草稿" });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "载入草稿" }));
    await screen.findByRole("alertdialog");
    view.rerender({ draftContent: "确认期间的新草稿" });
    fireEvent.click(screen.getByRole("button", { name: "替换草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("草稿已变化");
    expect(mocks.onUseDraft).not.toHaveBeenCalled();
  });

  it("summarizes the conversation on request but leaves author confirmation separate", async () => {
    sessions = [session()];
    history = [message("old", "USER", "主角的过去暂不决定")];
    setup();
    await open();
    const button = await screen.findByRole("button", { name: "整理定稿草案" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText("定稿草案已整理");
    expect(mocks.askProjectDiscussion).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("排除已否定的方案"),
    }));
    expect(mocks.onUseDraft).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("preserves failed input and reuses the newly created session on retry", async () => {
    mocks.askProjectDiscussion.mockRejectedValueOnce(new Error("网络中断"));
    setup();
    await open();
    await send("我的第一点想法");
    expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");
    expect(screen.getByRole("textbox", { name: "故事核心的讨论输入" })).toHaveValue("我的第一点想法");
    await send("我的第一点想法");
    await screen.findByText("回应：我的第一点想法");
    expect(mocks.createDiscussionSession).toHaveBeenCalledTimes(1);
  });

  it("restores unsent input after switching items without mixing conversations", async () => {
    const view = setup();
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "故事核心的讨论输入" }), { target: { value: "这个想法还没说完" } });
    view.rerender({ sectionId: "engine-protagonist" });
    await open();
    expect(screen.getByRole("textbox", { name: "故事核心的讨论输入" })).toHaveValue("");
    view.rerender({ sectionId: "seed-premise" });
    await open();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "故事核心的讨论输入" })).toHaveValue("这个想法还没说完"));
  });

  it("allows discussing locked settings but does not allow replacing their draft", async () => {
    sessions = [session()];
    history = [message("old", "ASSISTANT", "可进一步讨论")];
    setup({ readOnly: true });
    await open();
    expect(await screen.findByRole("button", { name: "载入草稿" })).toBeDisabled();
    await send("我想重新考虑这个设定");
    await screen.findByText("回应：我想重新考虑这个设定");
  });

  it("uses the project discussion model preference", async () => {
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ discussion: { profileId: "project-model", temperature: 0.2, maxOutputTokens: 2048 } });
    mocks.listModelProfiles.mockResolvedValue([
      { id: "model", capability: "CHAT", hasSecret: true },
      { id: "project-model", capability: "CHAT", hasSecret: true },
    ]);
    setup();
    await open();
    await send("先讨论我的想法");
    await screen.findByText("回应：先讨论我的想法");
    expect(mocks.askProjectDiscussion).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "project-model", temperature: 0.2, maxOutputTokens: 2048,
    }));
  });

  it("passes the current unsaved draft as reference without saving or confirming it", async () => {
    setup({ draftContent: "这是尚未保存的最新主角方向" });
    await open();
    await send("帮我看看这个方向的问题");
    await screen.findByText("回应：帮我看看这个方向的问题");
    expect(mocks.askProjectDiscussion).toHaveBeenCalledWith(expect.objectContaining({
      planningDraft: "这是尚未保存的最新主角方向",
      message: "帮我看看这个方向的问题",
    }));
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("prevents duplicate submission while a reply is pending", async () => {
    let finish!: (value: { userMessage: DiscussionMessage; assistantMessage: DiscussionMessage }) => void;
    mocks.askProjectDiscussion.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    setup();
    await open();
    await send("一个想法");
    const button = screen.getByRole("button", { name: "发送" });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.askProjectDiscussion).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    await act(async () => finish({ userMessage: message("u", "USER", "一个想法"), assistantMessage: message("a", "ASSISTANT", "回复") }));
    expect(await within(screen.getByRole("log")).findByText("回复")).toBeVisible();
  });
});
