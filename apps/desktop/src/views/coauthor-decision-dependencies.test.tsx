import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoauthorChangeSet, CoauthorDecision, CoauthorDecisionDependencyInput } from "../lib/tauri-client";
import { DecisionDependencyPicker, DecisionDependenciesReview, hasStaleDecisionDependencies } from "./coauthor-decision-dependencies";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p1", sessionId: "s1" };
let decision: CoauthorDecision;
const changed = vi.fn();
function Harness({ initial = [], session = "s1" }: { initial?: CoauthorDecisionDependencyInput[]; session?: string }) {
  const [value, setValue] = useState(initial);
  return <DecisionDependencyPicker key={session} scope={{ ...scope, sessionId: session }} value={value} disabled={false} hasSetting
    onChange={(next) => { setValue(next); changed(next); }} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  decision = { id: "rule1", topic: "突破代价", content: "不可消耗寿元", status: "REJECTED", version: 2, sourceMessageId: "author" };
  mocks.invoke.mockImplementation(async (_command, args) => ({ memories: [{ decision, aliases: ["代价"], quote: "否定寿元" }], offset: args.offset, hasMore: false }));
});
afterEach(cleanup);

it("loads only on expansion and binds exact decision versions to explicit item checkboxes", async () => {
  render(<Harness />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("依赖的讨论决定 · 0 条"));
  fireEvent.click(await screen.findByRole("checkbox", { name: "突破代价 → 当前工作稿" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "突破代价 → 新设定" }));
  expect(changed).toHaveBeenLastCalledWith([{ decisionId: "rule1", version: 2, itemIds: ["draft", "setting"] }]);
  expect(screen.getByText("已否定 · v2")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "移除决定依赖 rule1" }));
  expect(changed).toHaveBeenLastCalledWith([]);
  expect(mocks.invoke.mock.calls.every(([name]) => name === "search_coauthor_decisions")).toBe(true);
});

it("keeps chosen versions across paginated explicit searches", async () => {
  mocks.invoke.mockImplementation(async (_command, args) => ({ memories: [{ decision, aliases: [], quote: null }], offset: args.offset, hasMore: args.offset === 0 }));
  render(<Harness />);
  fireEvent.click(screen.getByText("依赖的讨论决定 · 0 条"));
  fireEvent.click(await screen.findByRole("checkbox", { name: "突破代价 → 当前工作稿" }));
  fireEvent.click(screen.getByRole("button", { name: "下一页依赖决定" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("search_coauthor_decisions", { scope, query: "", offset: 16 }));
  expect(changed).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.getByLabelText("搜索依赖决定")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("搜索依赖决定"), { target: { value: "别名代价" } });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(screen.getByLabelText("搜索依赖决定"), { key: "Enter" });
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("search_coauthor_decisions", { scope, query: "别名代价", offset: 0 }));
  expect(screen.getByText("rule1 · v2 · 当前工作稿")).toBeVisible();
});

it("never silently advances a restored dependency to a newer decision version", async () => {
  render(<Harness initial={[{ decisionId: "rule1", version: 1, itemIds: ["draft"] }]} />);
  fireEvent.click(screen.getByText("依赖的讨论决定 · 1 条"));
  expect(await screen.findByRole("alert")).toHaveTextContent("已选 v1，当前为 v2");
  expect(screen.getByRole("checkbox", { name: "突破代价 → 当前工作稿" })).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新选取此决定" }));
  expect(changed).toHaveBeenLastCalledWith([{ decisionId: "rule1", version: 2, itemIds: ["draft"] }]);
});

it("disables unverified cached choices on refresh failure without erasing selected metadata", async () => {
  render(<Harness initial={[{ decisionId: "rule1", version: 2, itemIds: ["draft"] }]} />);
  fireEvent.click(screen.getByText("依赖的讨论决定 · 1 条"));
  await screen.findByRole("checkbox", { name: "突破代价 → 当前工作稿" });
  mocks.invoke.mockRejectedValueOnce(new Error("目录暂不可读"));
  fireEvent.click(screen.getByRole("button", { name: "刷新依赖决定" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("目录暂不可读");
  expect(screen.getByRole("checkbox", { name: "突破代价 → 当前工作稿" })).toBeDisabled();
  expect(screen.getByText("rule1 · v2 · 当前工作稿")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

it("ignores a late directory after changing discussion scope", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<Harness />);
  fireEvent.click(screen.getByText("依赖的讨论决定 · 0 条"));
  await waitFor(() => expect(resolve).toBeDefined());
  view.rerender(<Harness session="s2" />);
  await act(async () => resolve({ memories: [{ decision, aliases: [], quote: null }], offset: 0, hasMore: false }));
  expect(screen.queryByRole("checkbox", { name: "突破代价 → 当前工作稿" })).not.toBeInTheDocument();
});

it("distinguishes stale selected rules, unaffected subsets, and legacy unknown dependency metadata", () => {
  const changes = { items: [{ id: "draft", document: { title: "正文" } }], decisionDependencies: [{
    itemIds: ["draft"], decision, current: { ...decision, version: 3, status: "WITHDRAWN" },
  }] } as CoauthorChangeSet;
  expect(hasStaleDecisionDependencies(changes, ["draft"])).toBe(true);
  expect(hasStaleDecisionDependencies(changes, ["setting"])).toBe(false);
  const view = render(<DecisionDependenciesReview changes={changes} selected={["draft"]} />);
  expect(screen.getByText("准备时 · v2 · 已否定")).toBeVisible();
  expect(screen.getByText("当前 · v3 · 已撤回")).toBeVisible();
  view.rerender(<DecisionDependenciesReview changes={changes} selected={["setting"]} />);
  expect(screen.getByRole("alert")).toHaveTextContent("不阻止其他独立项目");
  const legacy = { ...changes, decisionDependencies: null };
  expect(hasStaleDecisionDependencies(legacy, ["setting"])).toBe(true);
  view.rerender(<DecisionDependenciesReview changes={legacy} selected={["setting"]} />);
  expect(screen.getByRole("alert")).toHaveTextContent("旧方案未记录");
  view.rerender(<DecisionDependenciesReview changes={{ ...legacy, status: "COMMITTED" }} selected={["draft"]} />);
  expect(screen.getByRole("alert")).toHaveTextContent("此历史方案未记录决定依赖");
  view.rerender(<DecisionDependenciesReview changes={{ ...changes, status: "COMMITTED" }} selected={["draft"]} />);
  expect(screen.getByRole("alert")).toHaveTextContent("不重放采用或改写已提交内容");
});
