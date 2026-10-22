import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoauthorChecksPanel } from "./coauthor-checks-panel";
import type { CoauthorCheckPage, CoauthorCheckNotesPage } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "project", sessionId: "session" };
let page: CoauthorCheckPage;
let notesPage: CoauthorCheckNotesPage;

function mount(props: Partial<Parameters<typeof CoauthorChecksPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onContinue = vi.fn();
  return { ...render(<QueryClientProvider client={client}>
    <CoauthorChecksPanel scope={scope} isGenerating={false} onContinue={onContinue} {...props} />
  </QueryClientProvider>), onContinue };
}
beforeEach(() => {
  vi.clearAllMocks();
  page = {
    check: { id: "check", title: "核对全部旧章", query: "失忆代价是否影响旧章", kinds: ["MANUSCRIPT"],
      total: 2, read: 1, sent: 0, reviewed: 0, relevant: 0, uncertain: 0, stale: 0, added: 0,
      pendingIndexUpdates: 0, complete: false },
    entries: [{ key: "MANUSCRIPT:chapter", title: "雨夜", revision: "r1", totalChars: 6000, readChars: 6000,
      sentChars: 2000, sentComplete: false, nextOffset: 1000, stale: false,
      assessment: null, reason: "", quote: "", lastError: null }],
    offset: 0, hasMore: false,
  };
  notesPage = {
    checkId: "check", key: "MANUSCRIPT:chapter", revision: "r1", stale: false,
    totalNotes: 1, notedChars: 1000, offset: 0, hasMore: false,
    notes: [{ id: "note", runId: "previous-run", start: 0, end: 1000, version: 2,
      analysis: "这里只能确认回忆，不代表突破后的状态。", questions: "需要核对后文的叙事时间。", quote: "母亲的声音" }],
  };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_coauthor_source_checks") return { checks: [structuredClone(page.check)], hasMore: false };
    if (command === "get_coauthor_source_check" || command === "create_coauthor_source_check") return structuredClone(page);
    if (command === "get_coauthor_check_notes") return structuredClone(notesPage);
    throw new Error(command);
  });
});
afterEach(cleanup);

it("separates partial delivery, reading and judgments and returns exact continuation identity", async () => {
  const { onContinue } = mount();
  expect(await screen.findByText("范围查证尚未完成。")).toBeVisible();
  expect(screen.getByText("读取 6000 / 6000 字 · 送达 2000 字 · 续查位置 1000")).toBeVisible();
  expect(screen.getByText("未完成")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "继续查证" }));
  expect(onContinue).toHaveBeenCalledWith(page.check);
  expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_source_check", { scope, id: "check", offset: 0 });
});

it("keeps stale judgments as history and shows pending indexes and added sources", async () => {
  page.check = { ...page.check, stale: 1, added: 3, pendingIndexUpdates: 4 };
  page.entries[0] = { ...page.entries[0], stale: true, assessment: "RELEVANT", reason: "原章节代价不同", quote: "寿元将尽" };
  mount();
  expect(await screen.findByText("1 项原依据失效 · 3 项新增资料 · 4 项索引待更新")).toBeVisible();
  expect(screen.getByText("原判断：相关，不计入当前完成进度。")).toBeVisible();
  expect(screen.getByText("寿元将尽")).toBeVisible();
  expect(screen.getByRole("button", { name: "核对范围变化" })).toBeEnabled();
});

it("does not automatically run a model when creating a scoped inventory", async () => {
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("新建查证清单"));
  fireEvent.change(screen.getByLabelText("查证问题"), { target: { value: "查全部突破描写" } });
  fireEvent.click(screen.getByLabelText("有效设定卡"));
  fireEvent.click(screen.getByRole("button", { name: "创建清单" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("create_coauthor_source_check", {
    scope, input: { title: "全范围查证", query: "查全部突破描写", kinds: ["MANUSCRIPT", "ENTITY"] },
  }));
  expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor")).toBe(false);
});

it("keeps scope inputs when index construction fails and offers an explicit retry", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: unknown) => command === "create_coauthor_source_check"
    ? Promise.reject(new Error("索引还有 23 项待更新")) : base(command, args));
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("新建查证清单"));
  fireEvent.change(screen.getByLabelText("查证问题"), { target: { value: "查寿元代价" } });
  fireEvent.click(screen.getByRole("button", { name: "创建清单" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("索引还有 23 项待更新");
  expect(screen.getByLabelText("查证问题")).toHaveValue("查寿元代价");
  expect(screen.getByRole("button", { name: "创建清单" })).toBeEnabled();
});

it("distinguishes an empty range from a completed workflow", async () => {
  page.check.total = 0; page.entries = [];
  mount();
  expect(await screen.findByText("所选范围为空，未形成可查证的资料清单。")).toBeVisible();
  expect(screen.getByRole("button", { name: "继续查证" })).toBeDisabled();
});

it("retains unresolved cases and delivery errors without claiming completion", async () => {
  page.check.uncertain = 1;
  page.entries[0] = { ...page.entries[0], assessment: "UNCERTAIN", reason: "叙事位置尚不明确", lastError: "资料读取失败" };
  mount({ isGenerating: true });
  expect(await screen.findByText("叙事位置尚不明确")).toBeVisible();
  expect(screen.getByText("资料读取失败")).toBeVisible();
  expect(screen.getByRole("button", { name: "继续查证" })).toBeDisabled();
  expect(screen.getByText("范围查证尚未完成。")).toBeVisible();
});

it("paginates entries without mixing the selected source check", async () => {
  page.hasMore = true; page.check.total = 23;
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: { offset?: number }) => command === "get_coauthor_source_check" && args.offset === 20
    ? Promise.resolve({ ...page, entries: [{ ...page.entries[0], key: "MANUSCRIPT:last", title: "尾声" }], offset: 20, hasMore: false })
    : base(command, args));
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByRole("button", { name: "下一页条目" }));
  expect(await screen.findByText("尾声")).toBeVisible();
  expect(screen.queryByText("雨夜")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下一页条目" })).toBeDisabled();
});

it("does not continue after a failed progress refresh", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  let fail = false;
  mocks.invoke.mockImplementation((command: string, args: unknown) => command === "get_coauthor_source_check" && fail
    ? Promise.reject(new Error("读取清单失败")) : base(command, args));
  const { onContinue } = mount();
  await screen.findByText("雨夜");
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新查证进度" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("读取清单失败");
  expect(screen.getByRole("button", { name: "继续查证" })).toBeDisabled();
  expect(screen.getByText("当前进度无法核实，以下为上次记录。")).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
});

it("loads segmented analysis only when opened and keeps it distinct from formal facts", async () => {
  mount();
  await screen.findByText("雨夜");
  expect(mocks.invoke.mock.calls.some(([name]) => name === "get_coauthor_check_notes")).toBe(false);
  fireEvent.click(screen.getByText("分段分析笔记"));
  expect(await screen.findByText("这里只能确认回忆，不代表突破后的状态。")).toBeVisible();
  expect(screen.getByText("阶段分析，未经作者确认为正式事实。")).toBeVisible();
  expect(screen.getByText("字符 0 至 1000 · v2")).toBeVisible();
  expect(screen.getByText("未决问题：需要核对后文的叙事时间。")).toBeVisible();
  expect(screen.getByText("1 段笔记 · 分析覆盖 1000 字")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_check_notes", { scope, id: "check", key: "MANUSCRIPT:chapter", offset: 0 });
  expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor")).toBe(false);
  expect(screen.getByText("范围查证尚未完成。")).toBeVisible();
});

it("marks old source notes as historical even when the notes response is older", async () => {
  page.entries[0].stale = true;
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("分段分析笔记"));
  expect(await screen.findByText("原依据失效，以下分析仅作历史记录。")).toBeVisible();
  expect(screen.getByText("母亲的声音")).toBeVisible();
  expect(screen.queryByText("阶段分析，未经作者确认为正式事实。")).not.toBeInTheDocument();
});

it("paginates current note versions with exact check identity", async () => {
  notesPage.totalNotes = 6; notesPage.hasMore = true;
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: { offset?: number }) => command === "get_coauthor_check_notes" && args.offset === 5
    ? Promise.resolve({ ...notesPage, offset: 5, hasMore: false, notes: [{ ...notesPage.notes[0], id: "last", analysis: "后段尚有疑问。" }] })
    : base(command, args));
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("分段分析笔记"));
  await screen.findByText("这里只能确认回忆，不代表突破后的状态。");
  fireEvent.click(screen.getByRole("button", { name: "下一页笔记" }));
  expect(await screen.findByText("后段尚有疑问。")).toBeVisible();
  expect(screen.queryByText("这里只能确认回忆，不代表突破后的状态。")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下一页笔记" })).toBeDisabled();
  expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_check_notes", { scope, id: "check", key: "MANUSCRIPT:chapter", offset: 5 });
  fireEvent.click(screen.getByRole("button", { name: "上一页笔记" }));
  expect(await screen.findByText("这里只能确认回忆，不代表突破后的状态。")).toBeVisible();
});

it("keeps cached notes explicitly unverified when refreshing their status fails", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  let fail = false;
  mocks.invoke.mockImplementation((command: string, args: unknown) => command === "get_coauthor_check_notes" && fail
    ? Promise.reject(new Error("笔记读取失败")) : base(command, args));
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("分段分析笔记"));
  await screen.findByText("这里只能确认回忆，不代表突破后的状态。");
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新查证进度" }));
  expect(await screen.findByText("分析笔记无法核实：笔记读取失败")).toBeVisible();
  expect(screen.getByText("以下为上次笔记，当前有效性未核实。")).toBeVisible();
});

it("does not mix notes between different inventories or automatically load closed entries", async () => {
  const base = mocks.invoke.getMockImplementation()!;
  const second = { ...page.check, id: "second", title: "另一份查证" };
  mocks.invoke.mockImplementation((command: string, args: { id?: string }) => {
    if (command === "list_coauthor_source_checks") return Promise.resolve({ checks: [page.check, second], hasMore: false });
    if (command === "get_coauthor_source_check" && args.id === "second") return Promise.resolve({ ...page, check: second });
    return base(command, args);
  });
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("分段分析笔记"));
  await screen.findByText("这里只能确认回忆，不代表突破后的状态。");
  fireEvent.change(screen.getByLabelText("查证清单"), { target: { value: "second" } });
  await screen.findByRole("heading", { name: "另一份查证" });
  expect(screen.queryByText("这里只能确认回忆，不代表突破后的状态。")).not.toBeInTheDocument();
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "get_coauthor_check_notes")).toHaveLength(1);
});

it("distinguishes a source with no notes from missing original text", async () => {
  notesPage.totalNotes = 0; notesPage.notedChars = 0; notesPage.notes = [];
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("分段分析笔记"));
  expect(await screen.findByText("暂无分段分析笔记。")).toBeVisible();
  expect(screen.getByText("读取 6000 / 6000 字 · 送达 2000 字 · 续查位置 1000")).toBeVisible();
});
