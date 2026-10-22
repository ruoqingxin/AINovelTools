import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type { CoauthorDocument, CoauthorState, IpcRequests } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorView } from "./coauthor-view";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);

const baseline: CoauthorDocument = {
  sessionId: "s1", version: 1, kind: "MANUSCRIPT", title: "突破",
  content: "前半段保留。\n后半段寿元消散。", targetKey: null, targetRevision: null, narrativePosition: "金丹初期",
};
let stored: CoauthorState;
let pending: Array<{ input: IpcRequests["run_coauthor"]["input"]; resolve: (value: unknown) => void }>;
let handlers: Array<(event: { payload: { runId: string; sessionId: string; kind: string; content: string } }) => void>;
let posted: Array<{ id: string; sessionId: string; role: string; content: string }>;

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(<QueryClientProvider client={client}><ConfirmActionProvider><CoauthorView /></ConfirmActionProvider></QueryClientProvider>);
  return result;
}
function emit(runId: string, kind = "status", content = "正在推敲…") {
  act(() => handlers.forEach((handler) => handler({ payload: { runId, sessionId: "s1", kind, content } })));
}
async function begin(text = "写一个失忆版") {
  await screen.findByLabelText("工作稿内容");
  fireEvent.change(screen.getByLabelText("讨论输入"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
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
  await act(async () => request.resolve({ state: structuredClone(stored), runId: run.id }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/discussion");
  stored = { document: { ...baseline }, decisions: [], runs: [] };
  pending = []; handlers = []; posted = [];
  mocks.listen.mockImplementation(async (_name, handler) => { handlers.push(handler); return mocks.unlisten; });
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "current_project": return { projectId: "p1" };
      case "list_discussion_sessions": return [{ id: "s1", projectId: "p1", title: "境界讨论", scopeKind: "PROJECT" }];
      case "get_coauthor_state": return structuredClone(stored);
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
  it("uses real run IPC and applies authorized working edits without formal publication", async () => {
    renderWorkspace();
    const request = await begin();
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
    const request = await begin();
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
    const request = await begin();
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

  it("only-discussion mode does not grant working draft tools", async () => {
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    fireEvent.click(screen.getByLabelText("允许改工作稿"));
    const request = await begin("如果突破会失忆呢");
    expect(request.input.allowDraftEdits).toBe(false);
    await finish(request);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "apply_coauthor_proposal")).toBe(false);
  });

  it("shows formal scope and preview before confirmation and revokes an outdated confirmation", async () => {
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
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
    fireEvent.click(screen.getByRole("button", { name: "依据" }));
    expect(await screen.findByText("ENTITY · 检索命中 · 尚未随请求发送")).toBeVisible();
    expect(screen.queryByText(/已读取原文片段/)).not.toBeInTheDocument();
  });

  it("unsubscribes immediately on unmount and a late result cannot be applied", async () => {
    const view = renderWorkspace();
    const request = await begin();
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
    fireEvent.click(screen.getByRole("button", { name: "依据" }));
    expect(await screen.findByText("PLAN · 已读取原文片段 · 已随请求发送")).toBeVisible();
    expect(screen.getByText("突破消耗寿元")).toBeVisible();
    expect(screen.getByText("MANUSCRIPT · 已读取原文片段 · 尚未随请求发送")).toBeVisible();
    expect(screen.getByText("未发送的正文片段")).toBeVisible();
  });
});
