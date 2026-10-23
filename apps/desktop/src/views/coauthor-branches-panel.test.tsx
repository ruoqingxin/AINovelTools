import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoauthorBranchComparison, CoauthorBranchMerge, CoauthorDocument, IpcRequests } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorBranchesPanel } from "./coauthor-branches-panel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p1", sessionId: "s1" };
let document: CoauthorDocument;
let comparison: CoauthorBranchComparison;
let merge: CoauthorBranchMerge | null;
let generating: boolean;
const applied = vi.fn();
const saveDraft = vi.fn();
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);

function renderPanel(session = "s1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ConfirmActionProvider>
    <CoauthorBranchesPanel key={session} scope={{ ...scope, sessionId: session }}
      getDocument={() => document} saveDraft={saveDraft} isGenerating={() => generating} onApplied={applied} />
  </ConfirmActionProvider></QueryClientProvider>);
}
async function compare() {
  await screen.findByRole("option", { name: "子分支 · 失忆分支" });
  fireEvent.change(screen.getByLabelText("对照分支"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "比较分支" }));
  await screen.findByLabelText("合并来源稿");
}
async function prepare() {
  await compare();
  fireEvent.click(screen.getByRole("button", { name: "准备合并预览" }));
  await screen.findByRole("button", { name: "确认合并到工作稿" });
}
async function confirmation() {
  fireEvent.click(screen.getByRole("button", { name: "确认合并到工作稿" }));
  return screen.findByRole("alertdialog", { name: "合并分支文字" });
}
function select(label: string, start: number, end: number) {
  const textarea = screen.getByLabelText(label) as HTMLTextAreaElement;
  textarea.setSelectionRange(start, end);
  fireEvent.select(textarea);
}
beforeEach(() => {
  vi.clearAllMocks(); generating = false; merge = null;
  document = { sessionId: "s1", version: 4, title: "突破", kind: "MANUSCRIPT",
    content: "甲😀旧结尾，保留。", targetKey: null, targetRevision: null, narrativePosition: "金丹初期" };
  comparison = { branch: { sessionId: "s2", title: "失忆分支", relationship: "CHILD" },
    baseDocument: { ...document, version: 1 }, currentDocument: { ...document },
    sourceDocument: { ...document, sessionId: "s2", version: 3, content: "乙😀新结尾，来源。" } };
  saveDraft.mockImplementation(async () => structuredClone(document));
  applied.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "list_coauthor_branches") return { branches: [comparison.branch], hasMore: false };
    if (command === "compare_coauthor_branch") return structuredClone(comparison);
    if (command === "prepare_coauthor_branch_merge") {
      const input = args.input as IpcRequests["prepare_coauthor_branch_merge"]["input"];
      const source = [...comparison.sourceDocument.content].slice(input.sourceStart, input.sourceEnd).join("");
      const before = structuredClone(document);
      const after = { ...before, version: before.version + 1, content: [...before.content].slice(0, input.targetStart).join("")
        + source + [...before.content].slice(input.targetEnd).join("") };
      merge = { id: "merge1", status: "PENDING", branch: comparison.branch, before, source: comparison.sourceDocument,
        after, sourceStart: input.sourceStart, sourceEnd: input.sourceEnd, targetStart: input.targetStart, targetEnd: input.targetEnd };
      return structuredClone(merge);
    }
    if (command === "apply_coauthor_branch_merge") {
      merge = { ...merge!, status: "APPLIED" };
      return structuredClone(merge);
    }
    if (command === "get_coauthor_branch_merge") return structuredClone(merge);
    if (command === "list_coauthor_branch_merges") return {
      merges: merge ? [{ id: merge.id, status: merge.status, sourceTitle: merge.branch.title,
        beforeVersion: merge.before.version, sourceVersion: merge.source.version, afterVersion: merge.after.version }] : [],
      hasMore: false,
    };
    throw new Error(command);
  });
});
afterEach(cleanup);

it("loads a lightweight directory on opening and fetches documents and merge history only on demand", async () => {
  renderPanel();
  await screen.findByRole("option", { name: "子分支 · 失忆分支" });
  expect(calls("compare_coauthor_branch")).toHaveLength(0);
  expect(calls("list_coauthor_branch_merges")).toHaveLength(0);
  await compare();
  expect(saveDraft).toHaveBeenCalledOnce();
  expect(screen.getByText("继承起点 · v1")).toBeInTheDocument();
  expect(screen.getByLabelText("合并来源稿")).toHaveAttribute("readonly");
  expect(calls("prepare_coauthor_branch_merge")).toHaveLength(0);
  fireEvent.click(screen.getByText("分支合并记录"));
  await screen.findByText("此页没有合并记录。");
  expect(calls("list_coauthor_branch_merges")).toHaveLength(1);
});

it("previews exact Unicode source and target selections and requires explicit confirmation", async () => {
  renderPanel(); await compare();
  select("合并来源稿", 1, 6);
  select("合并目标稿", 1, 6);
  fireEvent.click(screen.getByRole("radio", { name: "替换当前选区" }));
  fireEvent.click(screen.getByRole("button", { name: "准备合并预览" }));
  await screen.findByRole("button", { name: "确认合并到工作稿" });
  expect(mocks.invoke).toHaveBeenCalledWith("prepare_coauthor_branch_merge", { scope, input: {
    sourceSessionId: "s2", expectedVersion: 4, sourceVersion: 3, sourceStart: 1, sourceEnd: 5, targetStart: 1, targetEnd: 5,
  } });
  expect(screen.getByLabelText("分支合并后")).toHaveTextContent("甲😀新结尾，保留。");
  expect(calls("apply_coauthor_branch_merge")).toHaveLength(0);
  const dialog = await confirmation();
  expect(dialog).toHaveTextContent("讨论决定、正式设定与其他章节不合并");
  fireEvent.click(within(dialog).getByRole("button", { name: "确认合并文字" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已合并为工作稿 v5");
  expect(applied).toHaveBeenCalledWith(expect.objectContaining({ status: "APPLIED", id: "merge1" }));
  expect(calls("run_coauthor")).toHaveLength(0);
});

it("supports append and explicit full replacement while rejecting empty or split-surrogate selections", async () => {
  renderPanel(); await compare();
  select("合并来源稿", 2, 3);
  expect(screen.getByRole("button", { name: "准备合并预览" })).toBeDisabled();
  select("合并来源稿", 3, 6);
  fireEvent.click(screen.getByRole("button", { name: "准备合并预览" }));
  await screen.findByRole("button", { name: "确认合并到工作稿" });
  const total = [...document.content].length;
  expect(calls("prepare_coauthor_branch_merge")[0][1].input).toMatchObject({ targetStart: total, targetEnd: total });
  fireEvent.click(screen.getByRole("radio", { name: "替换全文" }));
  expect(screen.queryByRole("button", { name: "确认合并到工作稿" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "准备合并预览" }));
  await screen.findByRole("button", { name: "确认合并到工作稿" });
  expect(calls("prepare_coauthor_branch_merge")[1][1].input).toMatchObject({ targetStart: 0, targetEnd: total });
});

it("blocks a draft changed while saving or during comparison without presenting an executable preview", async () => {
  saveDraft.mockImplementation(async () => { const result = { ...document }; document.content += "新"; return result; });
  renderPanel();
  await screen.findByRole("option", { name: "子分支 · 失忆分支" });
  fireEvent.change(screen.getByLabelText("对照分支"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "比较分支" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存期间工作稿仍在变化");
  expect(calls("compare_coauthor_branch")).toHaveLength(0);
});

it("withdraws old confirmation when editing or generation begins and cancellation never applies", async () => {
  renderPanel(); await prepare();
  let dialog = await confirmation();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "确认合并到工作稿" })).toBeEnabled());
  expect(calls("apply_coauthor_branch_merge")).toHaveLength(0);
  dialog = await confirmation();
  document = { ...document, content: "作者新编辑" }; generating = true;
  fireEvent.click(within(dialog).getByRole("button", { name: "确认合并文字" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("旧合并确认已失效");
  expect(calls("apply_coauthor_branch_merge")).toHaveLength(0);
});

it("keeps a rejected server preview and recovers a lost apply response from the durable receipt", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "apply_coauthor_branch_merge") { merge = { ...merge!, status: "APPLIED" }; throw new Error("响应丢失"); }
    return original(command, args);
  });
  renderPanel(); await prepare();
  const dialog = await confirmation();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认合并文字" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已合并为工作稿");
  expect(calls("apply_coauthor_branch_merge")).toHaveLength(1);
  expect(calls("get_coauthor_branch_merge")).toHaveLength(1);
  expect(applied).toHaveBeenCalledOnce();
});

it("does not fabricate success after a version conflict or receipt read error", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "apply_coauthor_branch_merge" || command === "get_coauthor_branch_merge") throw new Error("版本已变化");
    return original(command, args);
  });
  renderPanel(); await prepare();
  const dialog = await confirmation();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认合并文字" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("合并状态需重新核对");
  expect(screen.getByLabelText("分支合并后")).toBeInTheDocument();
  expect(applied).not.toHaveBeenCalled();
});

it("restores pending or applied receipts on demand and never reapplies historical receipts", async () => {
  renderPanel(); await prepare();
  fireEvent.click(screen.getByText("分支合并记录"));
  fireEvent.click(await screen.findByRole("button", { name: "查看合并记录" }));
  await waitFor(() => expect(calls("get_coauthor_branch_merge")).toHaveLength(1));
  expect(screen.getByRole("button", { name: "确认合并到工作稿" })).toBeEnabled();
  merge!.status = "APPLIED";
  fireEvent.click(screen.getByRole("button", { name: "查看合并记录" }));
  expect(await screen.findByRole("status")).toHaveTextContent("当前稿件可能已有后续编辑");
  expect(screen.queryByRole("button", { name: "确认合并到工作稿" })).not.toBeInTheDocument();
  expect(applied).not.toHaveBeenCalled();
});

it("paginates directories and history independently without loading full drafts or starting a model", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "list_coauthor_branches") return { branches: [comparison.branch], hasMore: args.offset === 0 };
    if (command === "list_coauthor_branch_merges") return { merges: [], hasMore: args.offset === 0 };
    return original(command, args);
  });
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "下一页分支" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_branches", { scope, offset: 20 }));
  expect(await screen.findByRole("button", { name: "下一页分支" })).toBeDisabled();
  fireEvent.click(screen.getByText("分支合并记录"));
  fireEvent.click(await screen.findByRole("button", { name: "下一页合并记录" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_branch_merges", { scope, offset: 10 }));
  expect(calls("compare_coauthor_branch")).toHaveLength(0);
  expect(calls("get_coauthor_branch_merge")).toHaveLength(0);
});

it("reports directory errors instead of claiming there are no branches and can retry", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("存储不可用"));
  renderPanel();
  expect(await screen.findByRole("alert")).toHaveTextContent("分支目录无法核实");
  expect(screen.queryByText("当前讨论没有直接父分支或子分支。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新分支目录" }));
  await screen.findByRole("option", { name: "子分支 · 失忆分支" });
});

it("blocks generation and mismatched document types before preparing a merge", async () => {
  comparison.sourceDocument.kind = "SETTING";
  renderPanel(); await compare();
  expect(screen.getByRole("alert")).toHaveTextContent("工作稿类型不同");
  expect(screen.getByRole("button", { name: "准备合并预览" })).toBeDisabled();
  generating = true;
  fireEvent.click(screen.getByRole("button", { name: "比较分支" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请先停止生成");
  expect(calls("prepare_coauthor_branch_merge")).toHaveLength(0);
});

it("discards late comparison results after unmounting or switching sessions", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  let resolve!: (value: CoauthorBranchComparison) => void;
  mocks.invoke.mockImplementation((command, args) => command === "compare_coauthor_branch"
    ? new Promise(done => { resolve = done; }) : original(command, args));
  const view = renderPanel();
  await screen.findByRole("option", { name: "子分支 · 失忆分支" });
  fireEvent.change(screen.getByLabelText("对照分支"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "比较分支" }));
  await waitFor(() => expect(resolve).toBeDefined());
  view.unmount();
  renderPanel("other");
  await act(async () => resolve(comparison));
  expect(screen.queryByLabelText("合并来源稿")).not.toBeInTheDocument();
  expect(calls("prepare_coauthor_branch_merge")).toHaveLength(0);
});
