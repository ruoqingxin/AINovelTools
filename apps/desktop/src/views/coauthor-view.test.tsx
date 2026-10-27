import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type { CoauthorDocument, CoauthorRun, CoauthorSource, CoauthorState, IpcRequests } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorView } from "./coauthor-view";
import { retrievalHeader } from "./coauthor-run-presentation";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);

const baseline: CoauthorDocument = {
  sessionId: "s1", version: 1, kind: "MANUSCRIPT", title: "突破",
  content: "前半段保留。\n后半段寿元消散。", targetKey: null, targetRevision: null, narrativePosition: "金丹初期",
};
let stored: Omit<CoauthorState, "runs"> & { runs: CoauthorRun[] };
let pending: Array<{ input: IpcRequests["run_coauthor"]["input"]; resolve: (value: unknown) => void }>;
let handlers: Array<(event: { payload: { runId: string; sessionId: string; kind: string; content: string } }) => void>;
let posted: Array<{ id: string; sessionId: string; role: string; content: string; contextVersion?: string }>;
let listedSessions: Array<{ id: string; projectId: string; title: string; scopeKind: string }>;
function lightState(): CoauthorState {
  return { ...structuredClone(stored), runs: stored.runs.map(({ output: _output, audit: _audit, ...summary }) => summary) };
}

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(<QueryClientProvider client={client}><ConfirmActionProvider><CoauthorView /></ConfirmActionProvider></QueryClientProvider>);
  return result;
}
function emit(runId: string, kind = "status", content = "正在推敲…") {
  act(() => handlers.forEach((handler) => handler({ payload: { runId, sessionId: "s1", kind, content } })));
}
async function begin(text = "写一个失忆版", allowEdits = false) {
  await screen.findByLabelText("工作稿内容");
  if (allowEdits) fireEvent.click(screen.getByLabelText("允许改工作稿"));
  fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: text } });
  const send = screen.getByRole("button", { name: "发送" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
  const request = pending[pending.length - 1];
  emit(request.input.runId);
  return request;
}
async function finish(request: (typeof pending)[number], status = "COMPLETED", content = "他忘了母亲的声音。") {
  const document = { ...baseline, content };
  const run = {
    id: request.input.runId, sessionId: "s1", userMessageId: "u1", status,
    documentVersion: baseline.version, output: "已试写，前半段保留。",
    audit: [{ kind: "draft_proposal", baseDocument: baseline, document }],
  };
  stored.runs = [run, ...stored.runs];
  await act(async () => request.resolve({ state: lightState(), runId: run.id, run }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/discussion");
  stored = { document: { ...baseline }, decisions: [], runs: [] };
  listedSessions = [{ id: "s1", projectId: "p1", title: "境界讨论", scopeKind: "PROJECT" }];
  pending = []; handlers = []; posted = [];
  mocks.listen.mockImplementation(async (_name, handler) => { handlers.push(handler); return mocks.unlisten; });
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "current_project": return { projectId: "p1" };
      case "list_discussion_sessions": return [...listedSessions];
      case "delete_discussion_session":
        listedSessions = listedSessions.filter((session) => session.id !== (args.scope as { sessionId: string }).sessionId);
        return null;
      case "get_coauthor_state": return lightState();
      case "list_coauthor_runs": return { runs: lightState().runs, hasMore: false };
      case "get_coauthor_run": {
        const run = stored.runs.find((entry) => entry.id === args.id);
        if (!run) throw new Error("指定运行不存在");
        return structuredClone(run);
      }
      case "get_ai_task_preferences": return emptyAiTaskPreferences;
      case "get_project_ai_task_overrides": return {};
      case "list_model_profiles": return [{ id: "model", hasSecret: true, name: "测试模型", capability: "CHAT" }];
      case "list_discussion_messages": return [...posted];
      case "save_coauthor_document": {
        const doc = args.document as CoauthorDocument;
        stored.document = { ...doc, version: doc.version + 1 };
        return structuredClone(stored.document);
      }
      case "run_coauthor": {
        const input = args.input as IpcRequests["run_coauthor"]["input"];
        posted.push({ id: input.runId, sessionId: "s1", role: "USER", content: input.message });
        return new Promise((resolve) => pending.push({ input, resolve }));
      }
      case "apply_coauthor_proposal": {
        stored.document = { ...baseline, content: "他忘了母亲的声音。", version: 2 };
        return structuredClone(stored.document);
      }
      case "cancel_coauthor_run": return null;
      case "list_coauthor_document_history": return [structuredClone(baseline)];
      case "publish_coauthor_document": return "MANUSCRIPT:published";
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

describe("coauthor workspace", () => {
  it("shows named workspace areas and preserves edits across full-width tabs", async () => {
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    expect(screen.getByRole("heading", { name: "讨论区" })).toBeVisible();
    expect(screen.getByLabelText("工作稿内容")).not.toBeVisible();
    expect(screen.getByText("当前讨论", { exact: true })).toBeVisible();
    const tools = screen.getByRole("group", { name: "讨论工具" });
    expect(within(tools).getByRole("button", { name: "查证范围" })).toHaveTextContent("查证范围");
    expect(within(tools).getByRole("button", { name: "依据与运行记录" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "尚未发送的问题" } });
    fireEvent.click(screen.getByRole("tab", { name: "工作稿" }));
    expect(screen.getByRole("heading", { name: "工作稿区" })).toBeVisible();
    expect(screen.getByLabelText("讨论输入")).not.toBeVisible();
    const draftTools = screen.getByRole("group", { name: "工作稿工具" });
    expect(within(draftTools).getByRole("button", { name: "另开分支" })).toHaveTextContent("另开分支");
    expect(within(draftTools).getByRole("button", { name: "工作稿版本" })).toHaveTextContent("工作稿版本");
    expect(screen.getByRole("button", { name: "保存工作稿" })).toHaveTextContent("保存工作稿");
    fireEvent.change(screen.getByLabelText("工作稿内容"), { target: { value: "尚未采用的工作稿" } });
    fireEvent.click(screen.getByRole("tab", { name: "讨论" }));
    expect(screen.getByRole("button", { name: "发送" })).toHaveTextContent("发送");
    expect(screen.getByLabelText("讨论输入")).toHaveValue("尚未发送的问题");
    expect(screen.getByLabelText("工作稿内容")).not.toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "工作稿" }));
    expect(screen.getByLabelText("工作稿内容")).toHaveValue("尚未采用的工作稿");
    expect(mocks.invoke.mock.calls.some(([name]) => ["run_coauthor", "publish_coauthor_document"].includes(name))).toBe(false);
  });

  it("cancels deletion without removing the discussion or its local input", async () => {
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "保留的输入" } });
    fireEvent.click(screen.getByRole("button", { name: "删除当前讨论" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除当前讨论" });
    expect(within(dialog).getByText(/已正式采用的内容和其他分支不变/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("当前讨论")).toHaveValue("s1");
    expect(screen.getByLabelText("讨论输入")).toHaveValue("保留的输入");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "delete_discussion_session")).toBe(false);
  });

  it("deletes only the confirmed current discussion and clears its exact local backups", async () => {
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "将被清除" } });
    localStorage.setItem("coauthor-draft:p1:s1", "当前讨论备份");
    localStorage.setItem("coauthor-draft:p1:other", "其他讨论备份");
    fireEvent.click(screen.getByRole("button", { name: "删除当前讨论" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除当前讨论" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除讨论" }));
    expect(await screen.findByRole("heading", { name: "从一个想法开始" })).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith("delete_discussion_session", { scope: { projectId: "p1", sessionId: "s1" } });
    expect(screen.getByLabelText("当前讨论")).toHaveValue("");
    expect(localStorage.getItem("coauthor-input:p1:s1")).toBeNull();
    expect(localStorage.getItem("coauthor-draft:p1:s1")).toBeNull();
    expect(localStorage.getItem("coauthor-draft:p1:other")).toBe("其他讨论备份");
    expect(window.location.hash).toBe("");
    expect(mocks.invoke.mock.calls.some(([name]) => ["publish_coauthor_document", "run_coauthor"].includes(name))).toBe(false);
  });

  it("selects a remaining discussion after deletion instead of keeping a stale URL", async () => {
    listedSessions.push({ id: "s2", projectId: "p1", title: "另一个讨论", scopeKind: "PROJECT" });
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.click(screen.getByRole("button", { name: "删除当前讨论" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除当前讨论" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除讨论" }));
    await waitFor(() => expect(screen.getByLabelText("当前讨论")).toHaveValue("s2"));
    expect(window.location.hash).toBe("#s2");
    expect(screen.queryByRole("option", { name: "境界讨论" })).not.toBeInTheDocument();
  });

  it("keeps the discussion and local backups when native deletion fails", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => command === "delete_discussion_session"
      ? Promise.reject(new Error("其他窗口仍在生成")) : original(command, args));
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "不能丢失" } });
    fireEvent.click(screen.getByRole("button", { name: "删除当前讨论" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除当前讨论" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除讨论" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("其他窗口仍在生成");
    expect(screen.getByLabelText("当前讨论")).toHaveValue("s1");
    expect(screen.getByLabelText("讨论输入")).toHaveValue("不能丢失");
    expect(localStorage.getItem("coauthor-input:p1:s1")).toBe("不能丢失");
  });

  it("disables deletion while a task is generating", async () => {
    renderWorkspace();
    const request = await begin();
    expect(screen.getByRole("button", { name: "删除当前讨论" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除当前讨论" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "delete_discussion_session")).toBe(false);
    await finish(request);
  });

  it("reports incomplete local cleanup after removing the discussion", async () => {
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "本机备份" } });
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage blocked"); });
    try {
      fireEvent.click(screen.getByRole("button", { name: "删除当前讨论" }));
      const dialog = await screen.findByRole("alertdialog", { name: "删除当前讨论" });
      fireEvent.click(within(dialog).getByRole("button", { name: "删除讨论" }));
      expect(await screen.findByRole("heading", { name: "从一个想法开始" })).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent("本机输入或工作稿备份未能完全清除");
      expect(remove).toHaveBeenCalledWith("coauthor-input:p1:s1");
      expect(remove).toHaveBeenCalledWith("coauthor-draft:p1:s1");
    } finally { remove.mockRestore(); }
  });

  it("keeps audit-only receipts out of replies and opens the exact run lazily with Chinese steps", async () => {
    const receipt = `${retrievalHeader}\n仅记录检索过程，不是回复内容。`;
    stored.runs = [{ id: "exact", sessionId: "s1", userMessageId: "u", documentVersion: 1,
      status: "COMPLETED", output: "正常回复", audit: [{ kind: "initial_decisions" }, { kind: "context_assembly" },
        { kind: "tool", name: "search_sources", result: { error: "失败" } },
        { kind: "retrieval_summary", displayText: receipt, receipts: [] }] }];
    posted = [{ id: "answer", sessionId: "s1", role: "ASSISTANT", content: "正常回复", contextVersion: "coauthor:exact" }];
    renderWorkspace();
    expect(await screen.findByText("正常回复")).toBeVisible();
    expect(screen.queryByText(/仅记录检索过程/)).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "查看本轮记录" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
    expect(within(panel).queryByText(/仅记录检索过程/)).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("tab", { name: "检索回执" }));
    expect(await within(panel).findByText(/仅记录检索过程/)).toBeVisible();
    fireEvent.click(within(panel).getByRole("tab", { name: "运行步骤" }));
    expect(screen.getByText("读取当前讨论的决定与约束")).toBeVisible();
    expect(screen.getByText("整理本轮参考资料、历史讨论与工作稿")).toBeVisible();
    expect(screen.getByText("按关键词检索资料 · 未成功执行")).toBeVisible();
    expect(screen.queryByText("initial_decisions")).not.toBeInTheDocument();
    expect(pending).toHaveLength(0);
  });

  it("moves historical footers entirely into the records panel without changing author text", async () => {
    const receipt = `${retrievalHeader}\n- 关键词 "契约"（项目资料，offset=0）：实际返回 0 条。\n`
      + "未检索到不等于不存在；未形成有效查询、未授权或索引不完整均不能证明查全。";
    const content = `旧回复正文。\n\n${receipt}`;
    posted = [{ id: "author", sessionId: "s1", role: "USER", content },
      { id: "answer", sessionId: "s1", role: "ASSISTANT", content, contextVersion: "coauthor:old" }];
    renderWorkspace();
    expect(await screen.findByText("旧回复正文。", { exact: true })).toBeVisible();
    const reply = screen.getByText("旧回复正文。", { exact: true }).closest("article")!;
    expect(within(reply).queryByText(/检索操作回执/)).not.toBeInTheDocument();
    expect(within(reply).queryByRole("button", { name: "核对这条回复" })).not.toBeInTheDocument();
    expect(screen.getByText(content, { exact: true, normalizer: (text) => text })).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run")).toBe(false);
    fireEvent.click(within(reply).getByRole("button", { name: "查看本轮记录" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
    fireEvent.click(within(panel).getByRole("tab", { name: "检索回执" }));
    expect(await within(panel).findByText(/实际返回 0 条/)).toBeVisible();
  });

  it("uses a Chinese action for live tool progress", async () => {
    renderWorkspace();
    const request = await begin();
    emit(request.input.runId, "tool", "search_sources");
    expect(screen.getByText("正在按关键词检索资料")).toBeVisible();
    expect(screen.queryByText(/search_sources/)).not.toBeInTheDocument();
    await finish(request);
  });

  it("keeps known quality limits visible and defaults to discussion without draft edits", async () => {
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    expect(screen.getByText(/生成完成不代表内容可靠/)).toBeVisible();
    expect(screen.getByLabelText("允许改工作稿")).not.toBeChecked();
    const request = await begin();
    expect(request.input.allowDraftEdits).toBe(false);
    await finish(request);
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
  });

  it("reads quality information only after opening the exact reply record", async () => {
    stored.runs = [{ id: "exact", sessionId: "s1", userMessageId: "u", documentVersion: 1, status: "COMPLETED", output: "试写",
      audit: [{ kind: "content_review", result: { decision: "PASS", issues: [] } }] }];
    posted = [{ id: "answer", sessionId: "s1", role: "ASSISTANT", content: "试写", contextVersion: "coauthor:exact" }];
    renderWorkspace();
    await screen.findByText("试写", { exact: true });
    expect(screen.queryByText("已生成 · 内容待核对")).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "查看本轮记录" }));
    expect(await screen.findByText(/同一模型复核未发现重大偏离/)).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_run", { scope: { projectId: "p1", sessionId: "s1" }, id: "exact" });
    expect(pending).toHaveLength(0);
  });

  it("keeps the last failure visible after remount even when there is no assistant reply", async () => {
    stored.runs = [{ id: "failed", sessionId: "s1", userMessageId: "u", documentVersion: 1, status: "FAILED", output: "",
      audit: [{ kind: "content_review_error" }, { kind: "error", message: "服务连接失败" }] }];
    const first = renderWorkspace();
    await screen.findByRole("button", { name: "查看原因与保留结果" });
    first.unmount();
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "查看原因与保留结果" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
    const feedback = await within(panel).findByRole("region", { name: "本轮问题与局限" });
    expect(within(feedback).getByText("服务连接失败")).toBeVisible();
    expect(within(panel).getByText(/复核返回的格式或引用未通过校验/)).toBeVisible();
    expect(pending).toHaveLength(0);
  });

  it("does not present unreadable issue records as a clean bill of health", async () => {
    posted = [{ id: "answer", sessionId: "s1", role: "ASSISTANT", content: "旧回答", contextVersion: "coauthor:missing" }];
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "查看本轮记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不能据此认定回答没有问题");
    expect(pending).toHaveLength(0);
  });

  it("brings an exact historical reply to the composer without sending and revokes edit permission", async () => {
    posted = [{ id: "exact-answer", sessionId: "s1", role: "ASSISTANT", content: "原句😀\n下一段。", contextVersion: "coauthor:old" }];
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "保留我的补充。" } });
    fireEvent.click(screen.getByLabelText("允许改工作稿"));
    expect(screen.getByLabelText("允许改工作稿")).toBeChecked();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "查看本轮记录" }));
    fireEvent.click(await screen.findByRole("button", { name: "核对这条回复" }));
    const input = screen.getByLabelText("讨论输入") as HTMLTextAreaElement;
    expect(input.value).toContain("保留我的补充。\n\n");
    expect(input.value).toContain('"messageId": "exact-answer"');
    expect(input.value).toContain(JSON.stringify("原句😀\n下一段。"));
    expect(input).toHaveFocus();
    expect(screen.getByLabelText("允许改工作稿")).not.toBeChecked();
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => ["run_coauthor", "save_coauthor_document"].includes(name))).toBe(false);
  });

  it("refuses an overlong review request without truncating or overwriting author input", async () => {
    posted = [{ id: "long", sessionId: "s1", role: "ASSISTANT", content: "字".repeat(20_000) }];
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "保留输入" } });
    fireEvent.click(await screen.findByRole("button", { name: "查看本轮记录" }));
    fireEvent.click(await screen.findByRole("button", { name: "核对这条回复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未截断或覆盖");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("讨论输入")).toHaveValue("保留输入");
    expect(screen.getByLabelText("讨论输入")).toHaveFocus();
    expect(pending).toHaveLength(0);
  });

  it("does not imply that preparing a review has revoked an already-running task's authorization", async () => {
    posted = [{ id: "old", sessionId: "s1", role: "ASSISTANT", content: "旧回答" }];
    renderWorkspace();
    const request = await begin("按授权试写", true);
    fireEvent.click(screen.getByRole("button", { name: "查看本轮记录" }));
    const review = screen.getByRole("button", { name: "核对这条回复" });
    expect(review).toBeDisabled();
    fireEvent.click(review);
    expect(screen.getByLabelText("允许改工作稿")).toBeChecked();
    expect(screen.getByLabelText("讨论输入")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "关闭依据与运行记录" }));
    fireEvent.click(screen.getByLabelText("停止生成"));
    await waitFor(() => expect(screen.queryByLabelText("停止生成")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "查看本轮记录" }));
    fireEvent.click(screen.getByRole("button", { name: "核对这条回复" }));
    expect(screen.getByLabelText("允许改工作稿")).not.toBeChecked();
    await finish(request);
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
  });

  it("brings the exact dependency review into the existing composer without sending, saving, or changing the draft", async () => {
    const decision = { id: "rule", version: 2, topic: "突破代价", content: "改用失忆", status: "CHOSEN", sourceMessageId: "author" };
    stored.decisions = [decision];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => command === "list_coauthor_decision_consumers"
      ? { decision: { ...decision, version: 3 }, unknownChangeSets: 0, offset: 0, hasMore: false, entries: [{
        changeSetId: "exact-old-plan", changeSetVersion: 2, changeSetTitle: "不应复制的全文指令", itemId: "rule-item",
        itemTitle: "旧规则", kind: "SETTING", decisionVersion: 1, state: "ADOPTED", needsReview: true,
        publishedKey: "ENTITY:old", publishedRevision: "r1",
      }] } : original(command, args));
    renderWorkspace(); await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "请保留我正在写的问题。" } });
    fireEvent.click(screen.getByRole("button", { name: /决定/ }));
    fireEvent.click(screen.getByText("决定关联与影响", { exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "带回讨论核对" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const input = (screen.getByLabelText("讨论输入") as HTMLTextAreaElement).value;
    expect(input).toContain("请保留我正在写的问题。\n\n");
    expect(input).toContain("决定 rule（目录读取时 v3）");
    expect(input).toContain("方案 exact-old-plan（v2）项目 rule-item");
    expect(input).toContain("原依赖决定 v1");
    expect(input).toContain("get_change_plan");
    expect(input).toContain("read_change_item");
    expect(input).toContain("本次只讨论核对");
    expect(input).not.toContain("不应复制的全文指令");
    expect(screen.getByLabelText("讨论输入")).toHaveFocus();
    expect((screen.getByLabelText("讨论输入") as HTMLTextAreaElement).selectionStart).toBe(input.length);
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => ["run_coauthor", "save_coauthor_document", "prepare_coauthor_changeset",
      "commit_coauthor_changeset", "commit_coauthor_reversal", "get_coauthor_changeset"].includes(name))).toBe(false);
    expect(pending).toHaveLength(0);
  });

  it("opens the exact decision-dependent receipt on demand without saving the draft or starting a model", async () => {
    const decision = { id: "rule", version: 2, topic: "突破代价", content: "改用失忆", status: "CHOSEN", sourceMessageId: "author" };
    stored.decisions = [decision];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "list_coauthor_decision_consumers") return { decision, unknownChangeSets: 0, offset: 0, hasMore: false, entries: [{
        changeSetId: "exact-old-plan", changeSetVersion: 1, changeSetTitle: "旧方案", itemId: "draft", itemTitle: "旧失忆试写",
        kind: "MANUSCRIPT", decisionVersion: 1, state: "PENDING", needsReview: true, publishedKey: null, publishedRevision: null,
      }] };
      if (command === "get_coauthor_changes") return { changeSets: [], impacts: [], hasMoreChanges: false, hasMoreImpacts: false };
      if (command === "get_coauthor_changeset") return {
        id: "exact-old-plan", version: 1, title: "准确的旧方案", status: "PENDING", baseDocument: baseline,
        coverage: "仅核对明确依赖", items: [], impacts: [], selectedIds: [], published: [], runId: null,
        undo: [], reversedBy: null, readDependencies: [], decisionDependencies: [],
      };
      return original(command, args);
    });
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "list_coauthor_decision_consumers")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /决定/ }));
    expect(mocks.invoke.mock.calls.some(([name]) => name === "list_coauthor_decision_consumers")).toBe(false);
    fireEvent.click(screen.getByText("决定关联与影响", { exact: true }));
    await screen.findByText("旧失忆试写");
    fireEvent.click(screen.getByRole("button", { name: "核对原方案" }));
    const panel = await screen.findByRole("dialog", { name: "关联变更与影响" });
    expect(await within(panel).findByRole("region", { name: "关联变更差异" })).toHaveTextContent("准确的旧方案");
    expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_changeset", { scope: { projectId: "p1", sessionId: "s1" }, id: "exact-old-plan" });
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => ["save_coauthor_document", "run_coauthor", "commit_coauthor_changeset"].includes(name))).toBe(false);
  });

  it("distinguishes semantic candidates and exposes coverage failures without treating them as read evidence", async () => {
    stored.runs = [{ id: "latest", sessionId: "s1", userMessageId: "m", documentVersion: 1, status: "COMPLETED", output: "",
      audit: [{ kind: "initial_semantic_search", result: {
        hits: [{ key: "ENTITY:memory", kind: "ENTITY", title: "回忆代偿", revision: "r1", content: "牺牲过去换取力量。",
          totalChars: 11, offset: 0, sessionId: null }],
        coverage: "索引只覆盖 8/17 个分块；不是全书查证。", sentChars: 8,
      } }, { kind: "tool", name: "search_semantic_sources", result: { error: "向量服务暂不可用", coverage: "不能据此断言没有设定。" } }],
    }];
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "依据与运行记录" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
    fireEvent.click(within(panel).getByRole("tab", { name: "参考资料" }));
    expect(await within(panel).findByText("ENTITY · 语义相似候选 · 检索命中 · 尚未随请求发送")).toBeVisible();
    const semantic = within(panel).getByText("语义检索覆盖 · 1");
    fireEvent.click(semantic);
    expect(within(semantic.closest("details")!).getByText("索引只覆盖 8/17 个分块；不是全书查证。")).toBeVisible();
    fireEvent.click(within(panel).getByText("语义检索覆盖 · 2"));
    expect(within(panel).getByRole("alert")).toHaveTextContent("向量服务暂不可用");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor" || name === "build_coauthor_semantic_batch")).toBe(false);
  });

  it("preserves fact provenance from historical audits and lazily reads original manuscript evidence", async () => {
    const fact: CoauthorSource = {
      key: "FACT:one", kind: "FACT", title: "陆沉 · 掌握 · 魂灯", revision: "fact1",
      content: "已审核事实记录，不是正文原句。", totalChars: 17, offset: 0, sessionId: null,
      knowledgeContext: { projectId: "p1", version: 1, status: "CURRENT", facts: [], hasMoreAnchors: false, totalAnchors: 1,
        anchors: [{ id: "a", chapterId: "chapter", revisionId: "r1", blockId: "p1", status: "CURRENT_REVISION" }] },
    };
    stored.runs = [{ id: "latest", sessionId: "s1", userMessageId: "m", documentVersion: 1,
      status: "COMPLETED", output: "", audit: [{ kind: "initial_search", result: { hits: [fact] } }] }];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) =>
      command === "read_coauthor_knowledge_evidence" ? {
        knowledgeKey: fact.key, knowledgeRevision: fact.revision, anchorId: "a", chapterId: "chapter",
        revisionId: "r1", blockId: "p1", start: 0, end: 8, content: "陆沉😀掌握魂灯。",
        offset: 0, nextOffset: 8, totalChars: 8, isCurrentRevision: true,
      } : original(command, args));
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "依据与运行记录" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
    fireEvent.click(within(panel).getByRole("tab", { name: "参考资料" }));
    expect(await within(panel).findByText("已审核事实记录 · v1")).toBeVisible();
    expect(within(panel).getByRole("button", { name: "查看记录" })).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "read_coauthor_knowledge_evidence")).toBe(false);
    fireEvent.click(within(panel).getByText("正文证据 · p1"));
    expect(await within(panel).findByText("陆沉😀掌握魂灯。")).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_knowledge_evidence", {
      scope: { projectId: "p1", sessionId: "s1" }, key: fact.key, revision: fact.revision, anchorId: "a", offset: 0, limit: 2000,
    });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor" || name === "list_coauthor_related_knowledge")).toBe(false);
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
  });

  it("reads a historical reply by exact run id outside the recent directory and blocks applying its whole proposal", async () => {
    stored.runs = [{ id: "latest", sessionId: "s1", userMessageId: "m", documentVersion: 1,
      status: "COMPLETED", output: "", audit: [] }];
    posted = [{ id: "old-message", sessionId: "s1", role: "ASSISTANT", content: "过去的试写", contextVersion: "coauthor:historical" }];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => command === "get_coauthor_run"
      && args.id === "historical" ? { id: "historical", sessionId: "s1", userMessageId: "old-user", documentVersion: 1,
        status: "COMPLETED", output: "过去的试写", audit: [
          { kind: "draft_proposal", baseDocument: baseline, document: { ...baseline, content: "旧建议正文" } },
        ] } : original(command, args));
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run" || name === "list_coauthor_runs")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "工作稿" }));
    expect(screen.getByRole("button", { name: "查看改稿建议" })).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run" || name === "list_coauthor_runs")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "讨论" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看本轮记录" }));
    expect(await screen.findByText("运行完成 · 基础稿件 v1")).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_run", { scope: { projectId: "p1", sessionId: "s1" }, id: "historical" });
    fireEvent.click(within(screen.getByRole("dialog", { name: "依据与运行记录" })).getByRole("button", { name: "查看改稿差异" }));
    expect(await screen.findByLabelText("AI 建议稿")).toHaveValue("旧建议正文");
    expect(screen.getByRole("button", { name: "采用整份工作稿修改" })).toBeDisabled();
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor" || name === "apply_coauthor_proposal")).toBe(false);
  });

  it("shows exact-run errors without inventing a missing-history conclusion or clearing author input", async () => {
    posted = [{ id: "old-message", sessionId: "s1", role: "ASSISTANT", content: "旧回复", contextVersion: "coauthor:missing" }];
    renderWorkspace();
    await screen.findByLabelText("讨论输入");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "保留我的输入" } });
    fireEvent.click(await screen.findByRole("button", { name: "查看本轮记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("运行记录无法核实");
    expect(screen.getByLabelText("讨论输入")).toHaveValue("保留我的输入");
    expect(screen.queryByText("此记录不在最近的运行列表中，原始讨论仍保留。")).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor" || name === "apply_coauthor_proposal")).toBe(false);
  });

  it("disables both adoption paths when a cached proposal cannot be verified on refresh", async () => {
    stored.runs = [{ id: "latest", sessionId: "s1", userMessageId: "m", documentVersion: 1,
      status: "COMPLETED", output: "", audit: [
        { kind: "draft_proposal", baseDocument: baseline, document: { ...baseline, content: "缓存建议" } },
      ] }];
    renderWorkspace();
    fireEvent.click(await screen.findByRole("tab", { name: "工作稿" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看改稿建议" }));
    await screen.findByLabelText("AI 建议稿");
    await waitFor(() => expect(screen.getByRole("button", { name: "采用整份工作稿修改" })).toBeEnabled());
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => command === "get_coauthor_run"
      ? Promise.reject(new Error("详情暂不可用")) : original(command, args));
    fireEvent.click(screen.getByRole("button", { name: "刷新运行记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("详情暂不可用");
    expect(screen.getByText("以下为上次读取的运行记录，当前状态尚未核实。")).toBeVisible();
    expect(screen.getByLabelText("AI 建议稿")).toHaveValue("缓存建议");
    expect(screen.getByRole("button", { name: "采用整份工作稿修改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "仅采用选中文字" })).toBeDisabled();
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
  });

  it("clears the prior proposal selection when switching between historical runs", async () => {
    stored.runs = ["latest", "earlier"].map((id) => ({
      id, sessionId: "s1", userMessageId: id, documentVersion: 1, status: "COMPLETED", output: `回复 ${id}`,
      audit: [{ kind: "draft_proposal", baseDocument: baseline, document: { ...baseline, content: `建议 ${id}` } }],
    }));
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("button", { name: "依据与运行记录" }));
    const sources = await screen.findByRole("dialog", { name: "依据与运行记录" });
    fireEvent.click(await within(sources).findByRole("button", { name: "查看改稿差异" }));
    const first = await screen.findByLabelText("AI 建议稿");
    await waitFor(() => expect(screen.getByRole("button", { name: "仅采用选中文字" })).toBeEnabled());
    fireEvent.select(first, { target: { selectionStart: 0, selectionEnd: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "关闭改稿差异" }));
    fireEvent.click(screen.getByRole("button", { name: "依据与运行记录" }));
    const reopened = await screen.findByRole("dialog", { name: "依据与运行记录" });
    await waitFor(() => expect(within(reopened).getByLabelText("查看运行")).toBeEnabled());
    fireEvent.change(within(reopened).getByLabelText("查看运行"), { target: { value: "earlier" } });
    await waitFor(() => expect(within(reopened).getByRole("button", { name: "查看改稿差异" })).toBeEnabled());
    fireEvent.click(within(reopened).getByRole("button", { name: "查看改稿差异" }));
    await waitFor(() => expect(screen.getByLabelText("AI 建议稿")).toHaveValue("建议 earlier"));
    await waitFor(() => expect(screen.getByRole("button", { name: "仅采用选中文字" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "仅采用选中文字" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请先在 AI 建议稿中选择要采用的文字。");
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
  });

  it("corrects a decision by stable identity and expected version without rewriting the manuscript", async () => {
    stored.decisions = [{ id: "decision", topic: "突破代价", content: "寿元", status: "CHOSEN", sourceMessageId: "old-author", version: 2 }];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "correct_coauthor_decision") {
        stored.decisions[0] = { ...stored.decisions[0], content: String(args.content), status: String(args.status), version: 3 };
        return stored.decisions[0];
      }
      return base(command, args);
    });
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("button", { name: /决定/ }));
    fireEvent.click(screen.getByRole("button", { name: "纠正" }));
    fireEvent.change(screen.getByLabelText("决定内容"), { target: { value: "撤回寿元，先不确定代价" } });
    fireEvent.change(screen.getByLabelText("决定状态"), { target: { value: "WITHDRAWN" } });
    fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("correct_coauthor_decision", {
      scope: { projectId: "p1", sessionId: "s1" }, id: "decision", expectedVersion: 2,
      content: "撤回寿元，先不确定代价", status: "WITHDRAWN",
    }));
    await waitFor(() => expect(screen.queryByLabelText("决定内容")).not.toBeInTheDocument());
    expect(screen.getByText("已撤回 · v3")).toBeVisible();
    expect(stored.document).toEqual(baseline);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor" || name === "publish_coauthor_document")).toBe(false);
  });

  it("keeps an author correction after a version conflict and does not retry with a guessed version", async () => {
    stored.decisions = [{ id: "decision", topic: "突破代价", content: "寿元", status: "CHOSEN", sourceMessageId: "old-author", version: 2 }];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => command === "correct_coauthor_decision"
      ? Promise.reject(new Error("决定版本已变化，请重新核对")) : base(command, args));
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("button", { name: /决定/ }));
    fireEvent.click(screen.getByRole("button", { name: "纠正" }));
    fireEvent.change(screen.getByLabelText("决定内容"), { target: { value: "保留作者新输入" } });
    fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("决定版本已变化");
    expect(screen.getByLabelText("决定内容")).toHaveValue("保留作者新输入");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "correct_coauthor_decision")).toHaveLength(1);
  });

  it("uses real run IPC and applies authorized working edits without formal publication", async () => {
    renderWorkspace();
    const request = await begin("写一个失忆版", true);
    expect(screen.getByLabelText("讨论输入")).toHaveValue("");
    expect(screen.getByLabelText("讨论输入")).not.toBeDisabled();
    emit(request.input.runId, "text", "正在写入失忆版本");
    expect(screen.getByText("正在写入失忆版本")).toBeVisible();
    await finish(request);
    await waitFor(() => expect(screen.getByLabelText("工作稿内容")).toHaveValue("他忘了母亲的声音。"));
    expect(mocks.invoke).toHaveBeenCalledWith("apply_coauthor_proposal", { scope: { projectId: "p1", sessionId: "s1" }, runId: request.input.runId, expectedVersion: 1 });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "publish_coauthor_document")).toBe(false);
    expect(mocks.unlisten).toHaveBeenCalled();
  });

  it("preserves author typing during generation and keeps the model edit for comparison", async () => {
    renderWorkspace();
    const request = await begin("写一个失忆版", true);
    fireEvent.change(screen.getByLabelText("工作稿内容"), { target: { value: "作者自己写的结尾。" } });
    await finish(request);
    expect(screen.getByLabelText("工作稿内容")).toHaveValue("作者自己写的结尾。");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
    expect(await screen.findByText("已保留 AI 改稿建议，当前编辑未被覆盖。")).toBeVisible();
    fireEvent.click(screen.getByText("查看改稿差异"));
    expect(await screen.findByLabelText("AI 建议稿")).toHaveValue("他忘了母亲的声音。");
    expect(screen.getByText("采用整份工作稿修改")).toBeDisabled();
  });

  it("cancellation invalidates automatic application before a late completed response", async () => {
    renderWorkspace();
    const request = await begin("写一个失忆版", true);
    fireEvent.click(screen.getByLabelText("停止生成"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cancel_coauthor_run", { scope: { projectId: "p1", sessionId: "s1" }, runId: request.input.runId }));
    await finish(request);
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
  });

  it("new instructions stop the old task and old results cannot overwrite the new task", async () => {
    renderWorkspace();
    const first = await begin();
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "等等，结尾不要死人" } });
    fireEvent.click(screen.getByLabelText("发送补充指令"));
    await waitFor(() => expect(pending).toHaveLength(2));
    const second = pending[1];
    expect(second.input.message).toBe("等等，结尾不要死人");
    emit(second.input.runId);
    await finish(first);
    expect(screen.getByLabelText("停止生成")).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
    await finish(second, "CANCELLED");
    expect(screen.getByLabelText("工作稿内容")).toHaveValue(baseline.content);
  });

  it("shows formal scope and preview before confirmation and revokes an outdated confirmation", async () => {
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("tab", { name: "工作稿" }));
    fireEvent.click(screen.getByRole("button", { name: "正式采用" }));
    await screen.findByRole("dialog", { name: "正式采用预览" });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "publish_coauthor_document")).toBe(false);
    fireEvent.click(screen.getByText("确认正式采用"));
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText(/仅提交当前稿件/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("工作稿内容"), { target: { value: "确认期间的新编辑。" } });
    fireEvent.click(within(confirmation).getByRole("button", { name: "正式采用" }));
    expect(await screen.findByText("确认期间工作稿已变化，旧确认已失效。")).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "publish_coauthor_document")).toBe(false);
  });

  it("rejects a cross-project deep link without loading a discussion", async () => {
    window.history.replaceState(null, "", "/discussion?targetProject=other&targetSession=s1");
    renderWorkspace();
    expect(await screen.findByText("讨论链接不属于当前项目，未读取或修改该讨论。")).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_state")).toBe(false);
  });

  it("does not label unsent retrieval candidates as model-read evidence", async () => {
    stored.runs = [{
      id: "budget", sessionId: "s1", userMessageId: "u1", documentVersion: 1,
      status: "LIMIT_REACHED", output: "上下文预算已用完", audit: [{
        kind: "initial_search", result: { hits: [{
          key: "ENTITY:realm", kind: "ENTITY", title: "修炼体系", revision: "revision-1",
          content: "金丹之后暂未确定。", sessionId: null, offset: 0, totalChars: 10,
        }] },
      }],
    }];
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("button", { name: "依据与运行记录" }));
    fireEvent.click(screen.getByRole("tab", { name: "参考资料" }));
    expect(await screen.findByText("ENTITY · 检索命中 · 尚未随请求发送")).toBeVisible();
    expect(screen.queryByText(/已读取原文片段/)).not.toBeInTheDocument();
  });

  it("unsubscribes immediately on unmount and a late result cannot be applied", async () => {
    const view = renderWorkspace();
    const request = await begin("写一个失忆版", true);
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalled();
    await finish(request);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
  });

  it("shows structured outline and manuscript reads with their actual delivery status", async () => {
    stored.runs = [{
      id: "reads", sessionId: "s1", userMessageId: "u1", documentVersion: 1, status: "COMPLETED", output: "", audit: [
        { kind: "tool", name: "read_outline_content", result: {
          key: "PLAN:plan-node:o", revision: "o1", title: "正式大纲", offset: 3, totalChars: 20, content: "突破消耗寿元" } },
        { kind: "model_request" },
        { kind: "tool", name: "read_manuscript_blocks", result: {
          key: "MANUSCRIPT:chapter", revision: "m1", blocks: [{ text: "未发送的正文片段" }] } },
      ],
    }];
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("button", { name: "依据与运行记录" }));
    fireEvent.click(screen.getByRole("tab", { name: "参考资料" }));
    expect(await screen.findByText("PLAN · 已读取原文片段 · 已随请求发送")).toBeVisible();
    expect(screen.getByText("突破消耗寿元")).toBeVisible();
    expect(screen.getByText("MANUSCRIPT · 已读取原文片段 · 尚未随请求发送")).toBeVisible();
    expect(screen.getByText("未发送的正文片段")).toBeVisible();
  });

  it("marks scoped check pages sent only after their own acknowledged delivery", async () => {
    stored.runs = [{
      id: "coverage", sessionId: "s1", userMessageId: "u1", documentVersion: 1, status: "FAILED", output: "", audit: [
        { kind: "tool", name: "read_check_source", result: {
          key: "MANUSCRIPT:sent", kind: "MANUSCRIPT", revision: "r1", title: "已送达章节", offset: 0, totalChars: 3,
          content: "送达了", readId: "read-1", checkId: "check" } },
        { kind: "model_request" },
        { kind: "check_delivery", readIds: ["read-1"] },
        { kind: "tool", name: "read_check_source", result: {
          key: "MANUSCRIPT:failed", kind: "MANUSCRIPT", revision: "r2", title: "请求失败章节", offset: 0, totalChars: 3,
          content: "未送达", readId: "read-2", checkId: "check" } },
        { kind: "model_request" }, { kind: "error", message: "provider failed" },
      ],
    }];
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("button", { name: "依据与运行记录" }));
    fireEvent.click(screen.getByRole("tab", { name: "参考资料" }));
    expect(await screen.findByText("MANUSCRIPT · 已读取原文片段 · 已随请求发送")).toBeVisible();
    expect(screen.getByText("MANUSCRIPT · 已读取原文片段 · 尚未随请求发送")).toBeVisible();
  });

  it("appends check continuation to existing author input without sending automatically", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    const check = { id: "check-1", title: "查全部旧章", query: "查失忆代价", kinds: ["MANUSCRIPT"],
      total: 1, read: 0, sent: 0, reviewed: 0, relevant: 0, uncertain: 0, stale: 0, added: 0,
      pendingIndexUpdates: 0, complete: false };
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "list_coauthor_source_checks") return Promise.resolve({ checks: [check], hasMore: false });
      if (command === "get_coauthor_source_check") return Promise.resolve({ check, entries: [], offset: 0, hasMore: false });
      return base(command, args);
    });
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: "保留我刚才的条件。" } });
    fireEvent.click(screen.getByRole("button", { name: "查证范围" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续查证" }));
    expect((screen.getByLabelText("讨论输入") as HTMLTextAreaElement).value).toContain("保留我刚才的条件。\n\n继续查证清单 check-1");
    expect(pending).toHaveLength(0);
  });

  it("loads branch comparison only on demand and applies its receipt while preserving newer local typing", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    let receipt: import("../lib/tauri-client").CoauthorBranchMerge;
    let resolveApply!: (value: typeof receipt) => void;
    const branch = { sessionId: "s2", title: "失忆分支", relationship: "CHILD" };
    const source = { ...baseline, sessionId: "s2", content: "分支新结尾。" };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "list_coauthor_branches") return { branches: [branch], hasMore: false };
      if (command === "compare_coauthor_branch") return {
        branch, baseDocument: baseline, currentDocument: structuredClone(stored.document), sourceDocument: source,
      };
      if (command === "prepare_coauthor_branch_merge") {
        const before = structuredClone(stored.document);
        const total = [...before.content].length;
        receipt = { id: "merge", status: "PENDING", branch, before, source,
          after: { ...before, version: before.version + 1, content: before.content + source.content },
          sourceStart: 0, sourceEnd: [...source.content].length, targetStart: total, targetEnd: total };
        return structuredClone(receipt);
      }
      if (command === "apply_coauthor_branch_merge") return new Promise(done => { resolveApply = done; });
      return base(command, args);
    });
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "list_coauthor_branches")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "工作稿" }));
    fireEvent.click(screen.getByRole("button", { name: "分支比较与合并" }));
    await screen.findByRole("option", { name: "子分支 · 失忆分支" });
    fireEvent.change(screen.getByLabelText("对照分支"), { target: { value: "s2" } });
    fireEvent.click(screen.getByRole("button", { name: "比较分支" }));
    fireEvent.click(await screen.findByRole("button", { name: "准备合并预览" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认合并到工作稿" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认合并文字" }));
    await waitFor(() => expect(resolveApply).toBeDefined());
    fireEvent.change(screen.getByLabelText("工作稿内容"), { target: { value: "请求等待期间作者又写了新段。" } });
    stored.document = { ...receipt!.after };
    await act(async () => resolveApply({ ...receipt!, status: "APPLIED" }));
    expect(screen.getByLabelText("工作稿内容")).toHaveValue("请求等待期间作者又写了新段。");
    expect(localStorage.getItem("coauthor-draft:p1:s1")).toContain("请求等待期间作者又写了新段");
    expect(screen.getByText("已合并为工作稿 v2，当前稿件可能已有后续编辑。")).toBeVisible();
    expect(pending).toHaveLength(0);
  });

  it("refreshes adopted branch decisions without saving or replacing concurrent local writing", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    let receipt: import("../lib/tauri-client").CoauthorBranchDecisionAdoption;
    let resolveApply!: (value: typeof receipt) => void;
    const branch = { sessionId: "s2", title: "失忆分支", relationship: "CHILD" };
    const memory = { decision: { id: "foreign", topic: "记忆例外", content: "丹药不能豁免代价", status: "CHOSEN", version: 2,
      sourceMessageId: "foreign-message" }, aliases: ["记忆例外"], quote: "保留丹药限制" };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "list_coauthor_branches") return { branches: [branch], hasMore: false };
      if (command === "list_coauthor_branch_decisions") return { memories: [memory], offset: 0, hasMore: false };
      if (command === "search_coauthor_decisions") return { memories: [], offset: 0, hasMore: false };
      if (command === "prepare_coauthor_branch_decision") {
        receipt = { id: "decision-adoption", status: "PENDING", branch, source: memory, before: null,
          after: { ...memory, decision: { ...memory.decision, id: "local", version: 1, sourceMessageId: "authorization" } } };
        return structuredClone(receipt);
      }
      if (command === "apply_coauthor_branch_decision") return new Promise(done => { resolveApply = done; });
      return base(command, args);
    });
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByRole("tab", { name: "工作稿" }));
    fireEvent.click(screen.getByRole("button", { name: "分支比较与合并" }));
    await screen.findByRole("option", { name: "子分支 · 失忆分支" });
    fireEvent.change(screen.getByLabelText("对照分支"), { target: { value: "s2" } });
    fireEvent.click(screen.getByText("分支决定对照与采用"));
    fireEvent.click(await screen.findByRole("radio", { name: "记忆例外 · 已选择 · v2" }));
    fireEvent.click(screen.getByRole("button", { name: "准备决定采用预览" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认采用到当前讨论" }));
    const confirmation = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmation).getByRole("button", { name: "确认采用决定" }));
    await waitFor(() => expect(resolveApply).toBeDefined());
    expect(mocks.invoke.mock.calls.some(([name]) => name === "save_coauthor_document")).toBe(false);
    fireEvent.change(screen.getByLabelText("工作稿内容"), { target: { value: "采用决定等待期间的新段。" } });
    stored.decisions = [receipt!.after.decision];
    await act(async () => resolveApply({ ...receipt!, status: "APPLIED" }));
    expect(screen.getByLabelText("工作稿内容")).toHaveValue("采用决定等待期间的新段。");
    expect(localStorage.getItem("coauthor-draft:p1:s1")).toContain("采用决定等待期间的新段");
    expect(screen.getByText(/已采用为决定 v1/)).toBeVisible();
    expect(pending).toHaveLength(0);
  });
});
