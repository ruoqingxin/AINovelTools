import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoauthorDecisionHistory, DecisionContext } from "./coauthor-decision-history";
import type { CoauthorDecision, CoauthorDecisionHistory as HistoryPage } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "project", sessionId: "session" };
const current: CoauthorDecision = { id: "decision", topic: "突破代价", content: "不再采用失忆，继续探索",
  status: "WITHDRAWN", sourceMessageId: "author-correction", version: 3 };
let history: HistoryPage;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}>
    <CoauthorDecisionHistory scope={scope} decision={current} />
  </QueryClientProvider>), client };
}

beforeEach(() => {
  vi.clearAllMocks();
  history = {
    current: { decision: current, aliases: ["突破代价", "境界损耗"], quote: "不再采用失忆" },
    revisions: [
      { decision: current, quote: "不再采用失忆" },
      { decision: { ...current, version: 2, content: "突破失去记忆", status: "CHOSEN", sourceMessageId: "old-author" }, quote: "就采用失忆" },
      { decision: { ...current, version: 1, content: "突破消耗寿元", status: "CHOSEN", sourceMessageId: "original" }, quote: null },
    ], hasMore: false,
  };
  mocks.invoke.mockImplementation(async () => structuredClone(history));
});
afterEach(cleanup);

it("loads only on expansion and separates current withdrawal from superseded choices", async () => {
  mount();
  expect(mocks.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("决定来源与修订"));
  expect(await screen.findByText("v3 · 当前修订")).toBeVisible();
  expect(screen.getByText("已撤回")).toBeVisible();
  expect(screen.getByText("v2 · 已替代（历史）")).toBeVisible();
  expect(screen.getByText("v1 · 已替代（历史）")).toBeVisible();
  expect(screen.getByText("主题别名：突破代价、境界损耗")).toBeVisible();
  expect(screen.getByText("就采用失忆")).toBeVisible();
  expect(screen.getByText("旧记录未保存独立原话，原始消息仍保留。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_decision_history", { scope, id: "decision", beforeVersion: null });
});

it("uses stable identity and version cursor for older pages and can return to newer history", async () => {
  history.current.decision = { ...current, version: 25 };
  history.revisions = Array.from({ length: 20 }, (_, index) => ({ decision: { ...current, version: 25 - index }, quote: "作者原话" }));
  history.hasMore = true;
  const older = { ...history, hasMore: false, revisions: [{ decision: { ...current, version: 5 }, quote: "早期原话" }] };
  mocks.invoke.mockImplementation(async (_command, args: { beforeVersion: number | null }) => args.beforeVersion === 6 ? older : structuredClone(history));
  mount();
  fireEvent.click(screen.getByText("决定来源与修订"));
  await screen.findByText("v25 · 当前修订");
  fireEvent.click(screen.getByRole("button", { name: "更早决定修订" }));
  expect(await screen.findByText("v5 · 已替代（历史）")).toBeVisible();
  expect(screen.getByRole("button", { name: "更早决定修订" })).toBeDisabled();
  expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_decision_history", { scope, id: "decision", beforeVersion: 6 });
  fireEvent.click(screen.getByRole("button", { name: "较新决定修订" }));
  expect(await screen.findByText("v25 · 当前修订")).toBeVisible();
});

it("shows errors without inventing a quote or claiming a current choice", async () => {
  mocks.invoke.mockRejectedValue(new Error("当前项目已变化"));
  mount();
  fireEvent.click(screen.getByText("决定来源与修订"));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前项目已变化");
  expect(screen.queryByText("就采用失忆")).not.toBeInTheDocument();
  expect(screen.queryByText("v3 · 当前修订")).not.toBeInTheDocument();
});

it("labels cached history as unverified after a failed refresh", async () => {
  const { client } = mount();
  fireEvent.click(screen.getByText("决定来源与修订"));
  await screen.findByText("v3 · 当前修订");
  mocks.invoke.mockRejectedValue(new Error("查询失败"));
  await act(async () => client.invalidateQueries({ queryKey: ["coauthor-decision-history"] }));
  expect(await screen.findByRole("alert")).toHaveTextContent("查询失败");
  expect(screen.getByText("以下为上次修订记录，当前状态尚未核实。")).toBeVisible();
});

it("does not let a late response for another branch replace the current branch", async () => {
  let resolveOld: (value: HistoryPage) => void = () => {};
  mocks.invoke.mockImplementation((_command, args: { scope: typeof scope }) => args.scope.sessionId === "session"
    ? new Promise<HistoryPage>((resolve) => { resolveOld = resolve; }) : Promise.resolve({ ...history,
      current: { ...history.current, aliases: ["另一分支"] }, revisions: [{ ...history.revisions[0], decision: { ...current, content: "另一分支内容" } }] }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderFor = (sessionId: string) => <QueryClientProvider client={client}>
    <CoauthorDecisionHistory key={sessionId} scope={{ ...scope, sessionId }} decision={current} />
  </QueryClientProvider>;
  const view = render(renderFor("session"));
  fireEvent.click(screen.getByText("决定来源与修订"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  view.rerender(renderFor("other"));
  fireEvent.click(screen.getByText("决定来源与修订"));
  await screen.findByText("另一分支内容");
  await act(async () => resolveOld(history));
  expect(screen.getByText("另一分支内容")).toBeVisible();
  expect(screen.queryByText("突破消耗寿元")).not.toBeInTheDocument();
});

it("renders history guards as read-time context without upgrading rejected or withdrawn choices", () => {
  render(<DecisionContext context={{ guards: [{ current, referencedVersion: 1, superseded: true }], hasMore: true }} />);
  expect(screen.getByText("关联旧选择已被替代", { exact: false })).toBeVisible();
  expect(screen.getByText("已撤回 · v3")).toBeVisible();
  expect(screen.getByText("不再采用失忆，继续探索")).toBeVisible();
  expect(screen.getByText("尚有决定关联未展开。")).toBeVisible();
  expect(screen.queryByText("突破消耗寿元")).not.toBeInTheDocument();
});
