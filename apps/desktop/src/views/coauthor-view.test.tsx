import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type { CoauthorDocument, CoauthorRun, CoauthorSource, CoauthorState, IpcRequests } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorView } from "./coauthor-view";

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
  await act(async () => request.resolve({ state: lightState(), runId: run.id, run }));
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
  it("distinguishes semantic candidates and exposes coverage failures without treating them as read evidence", async () => {
    stored.runs = [{ id: "latest", sessionId: "s1", userMessageId: "m", documentVersion: 1, status: "COMPLETED", output: "",
      audit: [{ kind: "initial_semantic_search", result: {
        hits: [{ key: "ENTITY:memory", kind: "ENTITY", title: "回忆代偿", revision: "r1", content: "牺牲过去换取力量。",
          totalChars: 11, offset: 0, sessionId: null }],
        coverage: "索引只覆盖 8/17 个分块；不是全书查证。", sentChars: 8,
      } }, { kind: "tool", name: "search_semantic_sources", result: { error: "向量服务暂不可用", coverage: "不能据此断言没有设定。" } }],
    }];
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "依据" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
    expect(await within(panel).findByText("ENTITY · 语义相似候选 · 检索命中 · 尚未随请求发送")).toBeVisible();
    fireEvent.click(within(panel).getByText("语义检索覆盖 · 1"));
    expect(within(panel).getByText("索引只覆盖 8/17 个分块；不是全书查证。")).toBeVisible();
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
    fireEvent.click(await screen.findByRole("button", { name: "依据" }));
    const panel = await screen.findByRole("dialog", { name: "依据与运行记录" });
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

  it("does not fetch run audits or the directory while writing with the panels closed", async () => {
    stored.runs = [{ id: "latest", sessionId: "s1", userMessageId: "m", documentVersion: 1,
      status: "COMPLETED", output: "", audit: [] }];
    renderWorkspace();
    await screen.findByLabelText("工作稿内容");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_run" || name === "list_coauthor_runs")).toBe(false);
    expect(screen.getByRole("button", { name: "查看运行结果" })).toBeVisible();
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
    fireEvent.click(await screen.findByRole("button", { name: "依据与记录" }));
    expect(await screen.findByText("已完成 · 基础稿件 v1")).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "依据与记录" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "查看运行结果" }));
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
    fireEvent.click(screen.getByRole("button", { name: "依据" }));
    const sources = await screen.findByRole("dialog", { name: "依据与运行记录" });
    fireEvent.click(await within(sources).findByRole("button", { name: "查看改稿差异" }));
    const first = await screen.findByLabelText("AI 建议稿");
    await waitFor(() => expect(screen.getByRole("button", { name: "仅采用选中文字" })).toBeEnabled());
    fireEvent.select(first, { target: { selectionStart: 0, selectionEnd: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "关闭改稿差异" }));
    fireEvent.click(screen.getByRole("button", { name: "依据" }));
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
    fireEvent.click(screen.getByRole("button", { name: "依据" }));
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
