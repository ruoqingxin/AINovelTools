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
      pendingIndexUpdates: 0, needsReview: 0, complete: false },
    entries: [{ key: "MANUSCRIPT:chapter", title: "雨夜", revision: "r1", totalChars: 6000, readChars: 6000,
      sentChars: 2000, sentComplete: false, nextOffset: 1000, stale: false,
      assessment: null, reason: "", quote: "", lastError: null, knowledgeStatus: null }],
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

function knowledgeFixture() {
  page.check = { ...page.check, kinds: ["FACT", "RELATION"], total: 1 };
  page.entries = [{ ...page.entries[0], key: "FACT:one", title: "陆沉 · 掌握 · 魂灯",
    revision: "fact-1", totalChars: 50, readChars: 50, sentChars: 50, nextOffset: 50,
    sentComplete: true, knowledgeStatus: "CURRENT" }];
  const fact = { key: "FACT:one", kind: "FACT", title: "陆沉 · 掌握 · 魂灯", revision: "fact-1",
    content: "已审核事实记录，不是正文原句。", offset: 0, totalChars: 50, sessionId: null,
    knowledgeContext: { projectId: "project", version: 1, status: "CURRENT", hasMoreAnchors: false, totalAnchors: 1,
      facts: [], anchors: [{ id: "anchor", chapterId: "chapter", revisionId: "original", blockId: "p1", status: "CURRENT_REVISION" }] } };
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_coauthor_source") return Promise.resolve(structuredClone(fact));
    if (command === "read_coauthor_knowledge_evidence") return Promise.resolve({
      knowledgeKey: fact.key, knowledgeRevision: fact.revision, anchorId: "anchor",
      chapterId: "chapter", revisionId: "original", blockId: "p1", start: 0, end: 8,
      content: "陆沉😀掌握魂灯。", offset: 0, nextOffset: 8, totalChars: 8, isCurrentRevision: true,
    });
    return base(command, args);
  });
  return fact;
}

it("supports explicitly selecting facts and relations without auto-running a model", async () => {
  mount();
  await screen.findByText("雨夜");
  fireEvent.click(screen.getByText("新建查证清单"));
  fireEvent.change(screen.getByLabelText("查证问题"), { target: { value: "核对全部知识记录" } });
  fireEvent.click(screen.getByLabelText("已审核事实"));
  fireEvent.click(screen.getByLabelText("关系记录"));
  fireEvent.click(screen.getByRole("button", { name: "创建清单" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("create_coauthor_source_check", {
    scope, input: { title: "全范围查证", query: "核对全部知识记录", kinds: ["MANUSCRIPT", "FACT", "RELATION"] },
  }));
  expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor")).toBe(false);
});

it("reads exact record and original evidence only when each is opened", async () => {
  knowledgeFixture();
  mount();
  await screen.findByText("记录文本读取 50 / 50 字 · 送达 50 字 · 续查位置 50");
  expect(mocks.invoke.mock.calls.some(([name]) => name === "read_coauthor_source")).toBe(false);
  fireEvent.click(screen.getByText("记录与正文证据"));
  expect(await screen.findByText("已审核事实记录，不是正文原句。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_source", {
    scope, key: "FACT:one", revision: "fact-1", offset: 0,
  });
  expect(mocks.invoke.mock.calls.some(([name]) => name === "read_coauthor_knowledge_evidence")).toBe(false);
  fireEvent.click(screen.getByText("正文证据 · p1"));
  expect(await screen.findByText("陆沉😀掌握魂灯。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_knowledge_evidence", {
    scope, key: "FACT:one", revision: "fact-1", anchorId: "anchor", offset: 0, limit: 2000,
  });
  expect(screen.getByRole("link", { name: "定位原修订" })).toHaveAttribute("href", expect.stringContaining("original"));
  expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor")).toBe(false);
});

it("shows unresolved knowledge evidence separately from the model assessment", async () => {
  knowledgeFixture();
  page.check = { ...page.check, needsReview: 1, read: 1, sent: 1, reviewed: 1, uncertain: 0 };
  page.entries[0] = { ...page.entries[0], assessment: "IRRELEVANT", knowledgeStatus: "NEEDS_REVIEW" };
  mount();
  expect(await screen.findByText("1 项事实或关系的依据待核对，不计为范围查证完成。")).toBeVisible();
  expect(screen.getByText("记录依据待核对")).toBeVisible();
  expect(screen.getByText("不相关")).toBeVisible();
  expect(screen.getByText("范围查证尚未完成。")).toBeVisible();
});

it("does not label a completed record workflow as verified manuscript evidence", async () => {
  knowledgeFixture();
  page.check = { ...page.check, complete: true, read: 1, sent: 1, reviewed: 1 };
  mount();
  expect(await screen.findByText("范围内记录逐项查证流程已完成，正文证据与适用条件仍需核对。")).toBeVisible();
  expect(screen.getByText("原证据修订仍在用，记录文本已读不代表正文证据已核实。")).toBeVisible();
});

it("keeps stale record lookup failure explicit and does not switch to the latest version", async () => {
  knowledgeFixture();
  page.entries[0].stale = true;
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: unknown) => command === "read_coauthor_source"
    ? Promise.reject(new Error("记录版本已经变化")) : base(command, args));
  mount();
  await screen.findByText("记录与正文证据");
  fireEvent.click(screen.getByText("记录与正文证据"));
  expect(await screen.findByText("记录无法核实：记录版本已经变化")).toBeVisible();
  expect(screen.getByText("清单原版本已失效，不将此处读取算作当前查证完成。")).toBeVisible();
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "read_coauthor_source")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.some(([name]) => name === "read_coauthor_knowledge_evidence")).toBe(false);
});

it("retains record cache as unverified after refresh failure without affecting author input", async () => {
  knowledgeFixture();
  const base = mocks.invoke.getMockImplementation()!;
  let fail = false;
  mocks.invoke.mockImplementation((command: string, args: unknown) => command === "read_coauthor_source" && fail
    ? Promise.reject(new Error("记录刷新失败")) : base(command, args));
  mount();
  await screen.findByText("记录与正文证据");
  fireEvent.click(screen.getByText("记录与正文证据"));
  await screen.findByText("已审核事实记录，不是正文原句。");
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新查证记录" }));
  expect(await screen.findByText("记录无法核实：记录刷新失败")).toBeVisible();
  expect(screen.getByText("以下为缓存记录，当前有效性尚未核实。")).toBeVisible();
  expect(screen.getByText("已审核事实记录，不是正文原句。")).toBeVisible();
  expect(mocks.invoke.mock.calls.some(([name]) => name === "run_coauthor")).toBe(false);
});

it("paginates record text using the exact Unicode offset and retains its revision", async () => {
  const fact = knowledgeFixture();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: { offset?: number }) => command === "read_coauthor_source"
    ? Promise.resolve({ ...fact, content: args.offset ? "丙丁戊" : "甲😀乙", offset: args.offset, totalChars: 6 })
    : base(command, args));
  mount();
  await screen.findByText("记录与正文证据");
  fireEvent.click(screen.getByText("记录与正文证据"));
  await screen.findByText("甲😀乙");
  fireEvent.click(screen.getByRole("button", { name: "下一段记录" }));
  expect(await screen.findByText("丙丁戊")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_source", { scope, key: "FACT:one", revision: "fact-1", offset: 3 });
  expect(screen.getByRole("button", { name: "下一段记录" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "上一段记录" }));
  expect(await screen.findByText("甲😀乙")).toBeVisible();
});

it("follows relation endpoint identities and returns to the exact checklist record", async () => {
  const fact = knowledgeFixture();
  page.entries[0] = { ...page.entries[0], key: "RELATION:one", revision: "relation-1", title: "守护关系" };
  const relation = { ...fact, key: "RELATION:one", revision: "relation-1", kind: "RELATION", title: "守护关系",
    content: "关系记录", knowledgeContext: { ...fact.knowledgeContext,
      facts: [{ key: fact.key, revision: fact.revision, title: fact.title }] } };
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: { key?: string }) => command === "read_coauthor_source"
    ? Promise.resolve(args.key === fact.key ? fact : relation) : base(command, args));
  mount();
  await screen.findByText("记录与正文证据");
  fireEvent.click(screen.getByText("记录与正文证据"));
  fireEvent.click(await screen.findByRole("button", { name: "起点事实 · 陆沉 · 掌握 · 魂灯" }));
  expect(await screen.findByText(fact.content)).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_source", { scope, key: fact.key, revision: fact.revision, offset: 0 });
  fireEvent.click(screen.getByRole("button", { name: "返回清单记录" }));
  expect(await screen.findByText("关系记录", { selector: "p", exact: true })).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_source", { scope, key: relation.key, revision: relation.revision, offset: 0 });
  expect(screen.queryByRole("button", { name: "返回清单记录" })).not.toBeInTheDocument();
});
