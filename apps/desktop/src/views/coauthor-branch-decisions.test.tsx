import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoauthorBranchDecisionAdoption, CoauthorDecisionMemory } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorBranchDecisions } from "./coauthor-branch-decisions";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p1", sessionId: "s1" };
let source: CoauthorDecisionMemory;
let target: CoauthorDecisionMemory;
let receipt: CoauthorBranchDecisionAdoption | null;
let generating: boolean;
const applied = vi.fn();
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
const lastArgs = (command: string) => { const history = calls(command); return history[history.length - 1][1]; };

function Harness({ session = "s1", branch = "s2" }) {
  const [busy, setBusy] = useState(false);
  return <CoauthorBranchDecisions key={`${session}:${branch}`} scope={{ ...scope, sessionId: session }}
    sourceId={branch} parentBusy={busy} isGenerating={() => generating} onBusyChange={setBusy} onApplied={applied} />;
}
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><ConfirmActionProvider><Harness /></ConfirmActionProvider></QueryClientProvider>), client };
}
async function choose(replace = true) {
  fireEvent.click(await screen.findByRole("radio", { name: "境界损耗 · 已选择 · v3" }));
  if (replace) fireEvent.click(await screen.findByRole("radio", { name: "突破代价 · 已否定 · v2" }));
}
async function prepare(replace = true) {
  await choose(replace);
  fireEvent.click(screen.getByRole("button", { name: "准备决定采用预览" }));
  await screen.findByRole("button", { name: "确认采用到当前讨论" });
}
async function dialog() {
  fireEvent.click(screen.getByRole("button", { name: "确认采用到当前讨论" }));
  return screen.findByRole("alertdialog", { name: "采用分支决定" });
}
beforeEach(() => {
  vi.clearAllMocks(); generating = false; receipt = null; applied.mockResolvedValue(undefined);
  source = { decision: { id: "source", topic: "境界损耗", content: "失去😀记忆", status: "CHOSEN", version: 3, sourceMessageId: "foreign-message" },
    aliases: ["境界损耗", "记忆代偿"], quote: "就采用失忆" };
  target = { decision: { id: "target", topic: "突破代价", content: "消耗寿元", status: "REJECTED", version: 2, sourceMessageId: "local-message" },
    aliases: ["突破代价", "寿元"], quote: "否定寿元" };
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "list_coauthor_branch_decisions") return { memories: [source], offset: args.offset, hasMore: false };
    if (command === "search_coauthor_decisions") return { memories: [target], offset: args.offset, hasMore: false };
    if (command === "prepare_coauthor_branch_decision") {
      const input = args.input as { targetDecisionId: string | null };
      const before = input.targetDecisionId ? structuredClone(target) : null;
      const after: CoauthorDecisionMemory = { ...structuredClone(before ?? source),
        decision: { ...(before ?? source).decision, id: before?.decision.id ?? "new",
          sourceMessageId: "authorization", version: (before?.decision.version ?? 0) + 1, content: source.decision.content, status: source.decision.status },
        quote: source.decision.content };
      receipt = { id: "adopt1", status: "PENDING", branch: { sessionId: "s2", title: "失忆分支", relationship: "CHILD" },
        source: structuredClone(source), before, after };
      return structuredClone(receipt);
    }
    if (command === "apply_coauthor_branch_decision") { receipt!.status = "APPLIED"; return structuredClone(receipt); }
    if (command === "get_coauthor_branch_decision") return structuredClone(receipt);
    if (command === "list_coauthor_branch_decision_adoptions") return { adoptions: receipt ? [{
      id: receipt.id, status: receipt.status, sourceTitle: receipt.branch.title, topic: receipt.after.decision.topic,
      decisionStatus: receipt.after.decision.status, sourceVersion: receipt.source.decision.version, afterVersion: receipt.after.decision.version,
    }] : [], hasMore: false };
    throw new Error(command);
  });
});
afterEach(cleanup);

it("loads both paginated decision directories but history only on demand", async () => {
  renderPanel();
  await screen.findByRole("radio", { name: "境界损耗 · 已选择 · v3" });
  expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_branch_decisions", { scope, sourceSessionId: "s2", query: "", offset: 0 });
  expect(calls("list_coauthor_branch_decision_adoptions")).toHaveLength(0);
  expect(calls("compare_coauthor_branch")).toHaveLength(0);
  expect(calls("run_coauthor")).toHaveLength(0);
  fireEvent.click(screen.getByText("分支决定采用记录"));
  await screen.findByText("此页没有决定采用记录。");
});

it("shows both statuses and evidence and requires explicit confirmation before replacing a rejected choice", async () => {
  renderPanel(); await prepare();
  expect(mocks.invoke).toHaveBeenCalledWith("prepare_coauthor_branch_decision", { scope, input: {
    sourceSessionId: "s2", sourceDecisionId: "source", sourceVersion: 3, targetDecisionId: "target", expectedVersion: 2,
  } });
  const preview = screen.getByRole("region", { name: "决定采用预览" });
  expect(preview).toHaveTextContent("已否定 · v2");
  expect(preview).toHaveTextContent("已选择 · v3");
  expect(preview).toHaveTextContent("别名：突破代价、寿元");
  expect(calls("apply_coauthor_branch_decision")).toHaveLength(0);
  const confirmation = await dialog();
  expect(confirmation).toHaveTextContent("从已否定变为已选择");
  expect(confirmation).toHaveTextContent("不修改工作稿、正式资料或其他决定");
  fireEvent.click(within(confirmation).getByRole("button", { name: "确认采用决定" }));
  await screen.findByText(/已采用为决定 v3/);
  expect(applied).toHaveBeenCalledOnce();
  expect(calls("save_coauthor_document")).toHaveLength(0);
  expect(calls("run_coauthor")).toHaveLength(0);
});

it("supports new local decisions without inferring a match from similar topics", async () => {
  renderPanel(); await prepare(false);
  expect(calls("prepare_coauthor_branch_decision")[0][1].input).toMatchObject({ targetDecisionId: null, expectedVersion: 0 });
  const preview = screen.getByRole("region", { name: "决定采用预览" });
  expect(preview).toHaveTextContent("不存在，确认后新建");
  expect(preview).toHaveTextContent("别名：境界损耗、记忆代偿");
});

it("cancellation or generation starting during confirmation never applies", async () => {
  renderPanel(); await prepare();
  let confirmation = await dialog();
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "确认采用到当前讨论" })).toBeEnabled());
  expect(calls("apply_coauthor_branch_decision")).toHaveLength(0);
  confirmation = await dialog(); generating = true;
  fireEvent.click(within(confirmation).getByRole("button", { name: "确认采用决定" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("确认期间已启动生成");
  expect(calls("apply_coauthor_branch_decision")).toHaveLength(0);
});

it("recovers a lost apply response from the exact durable receipt", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "apply_coauthor_branch_decision") { receipt!.status = "APPLIED"; throw new Error("响应丢失"); }
    return original(command, args);
  });
  renderPanel(); await prepare();
  const confirmation = await dialog();
  fireEvent.click(within(confirmation).getByRole("button", { name: "确认采用决定" }));
  await screen.findByText(/已采用为决定 v3/);
  expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_branch_decision", { scope, id: "adopt1" });
  expect(applied).toHaveBeenCalledOnce();
});

it("version conflicts remain pending and cannot be presented as success", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "apply_coauthor_branch_decision"
    ? Promise.reject(new Error("版本冲突")) : original(command, args));
  renderPanel(); await prepare();
  const confirmation = await dialog();
  fireEvent.click(within(confirmation).getByRole("button", { name: "确认采用决定" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
  expect(screen.queryByText(/已采用为决定/)).not.toBeInTheDocument();
  expect(applied).not.toHaveBeenCalled();
});

it("searches explicitly, clears old selections, pages directories and refuses stale cached rows after failure", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  let fail = false;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "list_coauthor_branch_decisions") {
      if (fail) throw new Error("目录离线");
      return { memories: [source], offset: args.offset, hasMore: args.offset === 0 };
    }
    return original(command, args);
  });
  renderPanel(); await choose();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索来源分支决定" }), { target: { value: "记忆" } });
  expect(calls("list_coauthor_branch_decisions")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "搜索来源分支决定按钮" }));
  await waitFor(() => expect(lastArgs("list_coauthor_branch_decisions")).toMatchObject({ query: "记忆", offset: 0 }));
  expect(screen.getByRole("button", { name: "准备决定采用预览" })).toBeDisabled();
  fireEvent.click(await screen.findByRole("radio", { name: "境界损耗 · 已选择 · v3" }));
  fireEvent.click(screen.getByRole("button", { name: "下一页来源分支决定" }));
  await waitFor(() => expect(lastArgs("list_coauthor_branch_decisions")).toMatchObject({ query: "记忆", offset: 16 }));
  fail = true;
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新来源分支决定" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "刷新来源分支决定" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("目录离线");
  expect(screen.getByRole("radio", { name: "境界损耗 · 已选择 · v3" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "准备决定采用预览" })).toBeDisabled();
});

it("restores previews or applied receipts from history without automatically replaying them", async () => {
  renderPanel(); await prepare();
  fireEvent.click(screen.getByText("分支决定采用记录"));
  fireEvent.click(await screen.findByRole("button", { name: "查看决定采用记录" }));
  expect(screen.getByRole("button", { name: "确认采用到当前讨论" })).toBeInTheDocument();
  expect(calls("apply_coauthor_branch_decision")).toHaveLength(0);
  await waitFor(() => expect(screen.getByRole("button", { name: "查看决定采用记录" })).toBeEnabled());
  receipt!.status = "APPLIED";
  fireEvent.click(screen.getByRole("button", { name: "查看决定采用记录" }));
  await screen.findByText(/已采用为决定 v3/);
  expect(screen.queryByRole("button", { name: "确认采用到当前讨论" })).not.toBeInTheDocument();
});

it("ignores a late prepare response after closing the panel", async () => {
  let resolve!: (value: CoauthorBranchDecisionAdoption) => void;
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    return command === "prepare_coauthor_branch_decision" ? new Promise((done) => { resolve = done; }) : result;
  });
  const view = renderPanel(); await choose();
  fireEvent.click(screen.getByRole("button", { name: "准备决定采用预览" }));
  await waitFor(() => expect(receipt).not.toBeNull());
  view.unmount();
  await act(async () => { resolve(receipt!); });
  expect(applied).not.toHaveBeenCalled();
  expect(calls("apply_coauthor_branch_decision")).toHaveLength(0);
});

it("isolates decision rows and late source responses when the selected branch changes", async () => {
  let resolve!: (value: unknown) => void;
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "list_coauthor_branch_decisions" && args.sourceSessionId === "s2"
    ? new Promise((done) => { resolve = done; }) : original(command, args));
  const view = renderPanel();
  await waitFor(() => expect(resolve).toBeDefined());
  source = { ...source, decision: { ...source.decision, id: "other-source", topic: "另一分支", version: 5 } };
  view.rerender(<QueryClientProvider client={view.client}><ConfirmActionProvider><Harness branch="s3" /></ConfirmActionProvider></QueryClientProvider>);
  await screen.findByRole("radio", { name: "另一分支 · 已选择 · v5" });
  await act(async () => resolve({ memories: [{ ...source, decision: { ...source.decision, topic: "旧分支迟到内容" } }], offset: 0, hasMore: false }));
  expect(screen.queryByText("旧分支迟到内容", { exact: false })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "准备决定采用预览" })).toBeDisabled();
});
