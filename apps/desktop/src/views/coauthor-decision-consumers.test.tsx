import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoauthorDecision, CoauthorDecisionConsumersPage } from "../lib/tauri-client";
import { CoauthorDecisionConsumers } from "./coauthor-decision-consumers";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p1", sessionId: "s1" };
const openPlan = vi.fn();
let decision: CoauthorDecision;
let page: CoauthorDecisionConsumersPage;
function mount(session = "s1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const content = (id: string) => <QueryClientProvider client={client}>
    <CoauthorDecisionConsumers scope={{ ...scope, sessionId: id }} decision={decision} onOpenChangeSet={openPlan} />
  </QueryClientProvider>;
  const view = render(content(session));
  return { ...view, changeScope: (id: string) => view.rerender(content(id)), changeVersion: () => view.rerender(content(session)) };
}
function expand() { fireEvent.click(screen.getByText("决定关联与影响", { exact: true })); }
beforeEach(() => {
  vi.clearAllMocks();
  decision = { id: "rule", version: 2, topic: "突破代价", content: "改为失忆", status: "CHOSEN", sourceMessageId: "author" };
  page = { decision, entries: [{
    changeSetId: "old-plan", changeSetVersion: 2, changeSetTitle: "原失忆方案", itemId: "draft", itemTitle: "突破试写",
    kind: "MANUSCRIPT", decisionVersion: 1, state: "ADOPTED", needsReview: true,
    publishedKey: "MANUSCRIPT:old", publishedRevision: "original-revision",
  }], unknownChangeSets: 1, offset: 0, hasMore: false };
  mocks.invoke.mockImplementation(async () => structuredClone(page));
});
afterEach(cleanup);

it("loads the exact current discussion only on expansion and navigates to the exact receipt without executing writes", async () => {
  mount(); expect(mocks.invoke).not.toHaveBeenCalled();
  expand();
  expect(await screen.findByText("读取时当前决定 · v2 · 已选择")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_decision_consumers", {
    scope, decisionId: "rule", needsReviewOnly: true, offset: 0,
  });
  expect(screen.getByText("正文 · 已采用项目 · 依赖 v1")).toBeVisible();
  expect(screen.getByText("当时采用修订：original-revision")).toBeVisible();
  expect(screen.getByText(/另有 1 份/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看采用回执" }));
  expect(openPlan).toHaveBeenCalledExactlyOnceWith("old-plan");
  expect(mocks.invoke.mock.calls.every(([name]) => name === "list_coauthor_decision_consumers")).toBe(true);
});

it("paginates declared items and resets to the first page when including non-actionable history", async () => {
  page.hasMore = true;
  mocks.invoke.mockImplementation(async (_command, args) => ({ ...structuredClone(page), offset: args.offset, hasMore: args.offset === 0 }));
  mount(); expand(); await screen.findByText("突破试写");
  fireEvent.click(screen.getByRole("button", { name: "下一页决定关联" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_decision_consumers", {
    scope, decisionId: "rule", needsReviewOnly: true, offset: 16,
  }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "仅需复查" })).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox", { name: "仅需复查" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_decision_consumers", {
    scope, decisionId: "rule", needsReviewOnly: false, offset: 0,
  }));
  expect(await screen.findByRole("button", { name: "上一页决定关联" })).toBeDisabled();
});

it("withdraws current verification and disables cached navigation when refreshing fails", async () => {
  mount(); expand(); await screen.findByText("突破试写");
  mocks.invoke.mockRejectedValueOnce(new Error("索引不可用"));
  fireEvent.click(screen.getByRole("button", { name: "刷新决定关联" }));
  expect(await screen.findByText(/决定关联无法核实/)).toHaveTextContent("索引不可用");
  expect(screen.getByText(/以下为缓存记录/)).toBeVisible();
  expect(screen.getByText("上次读取时标记需复查，当前状态未核实。")).toBeVisible();
  expect(screen.getByRole("button", { name: "查看采用回执" })).toBeDisabled();
  expect(openPlan).not.toHaveBeenCalled();
  expect(screen.queryByText("决定版本已变化，需复查此项。")).not.toBeInTheDocument();
});

it("does not turn an empty declared directory into a claim of no semantic influence", async () => {
  page.entries = []; page.unknownChangeSets = 0;
  mount(); expand();
  expect(await screen.findByText("没有需要复查的明确依赖项。")).toBeVisible();
  expect(screen.getByText(/未自动检查隐含语义关系/)).toBeVisible();
  expect(screen.queryByText(/全书没有影响/)).not.toBeInTheDocument();
});

it("distinguishes pending, adopted, unselected, discarded and reversed entries in full history", async () => {
  page.entries = ["PENDING", "ADOPTED", "NOT_ADOPTED", "DISCARDED", "REVERSED"].map((state, index) => ({
    ...page.entries[0], itemId: `item${index}`, itemTitle: `项目${index}`, state, needsReview: ["PENDING", "ADOPTED"].includes(state),
  }));
  mount(); expand();
  await screen.findByText("项目4");
  for (const text of ["待确认方案", "已采用项目", "本项未采用", "方案已放弃", "采用已撤销"]) {
    expect(screen.getByText(`正文 · ${text} · 依赖 v1`)).toBeVisible();
  }
  expect(screen.getAllByText("决定版本已变化，需复查此项。")).toHaveLength(2);
});

it("ignores late data from a closed prior discussion after scope changes", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = mount(); expand();
  await waitFor(() => expect(resolve).toBeDefined());
  view.changeScope("s2");
  await act(async () => resolve(structuredClone(page)));
  expect(screen.queryByText("突破试写")).not.toBeInTheDocument();
  expect(openPlan).not.toHaveBeenCalled();
  expand(); await screen.findByText("突破试写");
  expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_decision_consumers", {
    scope: { ...scope, sessionId: "s2" }, decisionId: "rule", needsReviewOnly: true, offset: 0,
  });
});

it("resets a changed decision version without silently treating old cached results as verified", async () => {
  const view = mount(); expand(); await screen.findByText("突破试写");
  decision = { ...decision, version: 3, status: "WITHDRAWN" }; page.decision = decision;
  view.changeVersion();
  expect(screen.queryByText("突破试写")).not.toBeInTheDocument();
  expand();
  expect(await screen.findByText("读取时当前决定 · v3 · 已撤回")).toBeVisible();
});
