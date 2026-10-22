import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoauthorRunDirectory } from "./coauthor-run-directory";
import type { CoauthorRunsPage } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p", sessionId: "s" };
const select = vi.fn();
const page: CoauthorRunsPage = { runs: Array.from({ length: 20 }, (_, i) => ({
  id: `run-${30-i}`, sessionId: "s", userMessageId: `message-${i}`, status: "COMPLETED", documentVersion: i,
})), hasMore: true };
function tree(sessionId = "s") {
  return <CoauthorRunDirectory key={sessionId} scope={{ ...scope, sessionId }} selected="old-run" onSelect={select} />;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{tree()}</QueryClientProvider>);
  return { client, view };
}
beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockResolvedValue(structuredClone(page)); });
afterEach(cleanup);

it("loads a lightweight directory without fetching details or changing the selected historical run", async () => {
  mount();
  expect(await screen.findByRole("option", { name: "已完成 · run-30 · 稿件 v0" })).toBeInTheDocument();
  expect(screen.getByLabelText("查看运行")).toHaveValue("old-run");
  expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_runs", { scope, beforeRunId: null });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(select).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("查看运行"), { target: { value: "run-30" } });
  expect(select).toHaveBeenCalledWith("run-30");
});

it("pages by the exact last run identity and can return to newer runs", async () => {
  mocks.invoke.mockImplementation(async (_command, args: { beforeRunId: string | null }) => args.beforeRunId
    ? { runs: [{ ...page.runs[0], id: "run-10" }], hasMore: false } : structuredClone(page));
  mount();
  await screen.findByRole("option", { name: "已完成 · run-30 · 稿件 v0" });
  fireEvent.click(screen.getByLabelText("更早运行"));
  expect(await screen.findByRole("option", { name: "已完成 · run-10 · 稿件 v0" })).toBeInTheDocument();
  expect(mocks.invoke).toHaveBeenCalledWith("list_coauthor_runs", { scope, beforeRunId: "run-11" });
  expect(screen.getByLabelText("更早运行")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("较新运行"));
  expect(await screen.findByRole("option", { name: "已完成 · run-30 · 稿件 v0" })).toBeInTheDocument();
  expect(screen.getByLabelText("查看运行")).toHaveValue("old-run");
});

it("keeps cached directory marked unverified after a refresh failure and permits an explicit retry", async () => {
  mount();
  await screen.findByRole("option", { name: "已完成 · run-30 · 稿件 v0" });
  mocks.invoke.mockRejectedValue(new Error("读取失败"));
  fireEvent.click(screen.getByLabelText("刷新运行目录"));
  expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
  expect(screen.getByText("当前显示缓存目录，状态尚未核实。")).toBeVisible();
  expect(screen.getByLabelText("查看运行")).toBeDisabled();
  expect(screen.getByLabelText("更早运行")).toBeDisabled();
  mocks.invoke.mockResolvedValue({ runs: [], hasMore: false });
  fireEvent.click(screen.getByLabelText("刷新运行目录"));
  expect(await screen.findByText("此页没有运行记录。")).toBeVisible();
});

it("does not report a failed directory query as an empty history", async () => {
  mocks.invoke.mockRejectedValue(new Error("当前项目不一致"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("当前项目不一致");
  expect(screen.queryByText("此页没有运行记录。")).not.toBeInTheDocument();
});

it("does not let a late directory response replace another branch", async () => {
  let resolve: (value: CoauthorRunsPage) => void = () => {};
  mocks.invoke.mockImplementation((_command, args: { scope: typeof scope }) => args.scope.sessionId === "s"
    ? new Promise<CoauthorRunsPage>((done) => { resolve = done; })
    : Promise.resolve({ runs: [{ ...page.runs[0], id: "other" }], hasMore: false }));
  const { client, view } = mount();
  view.rerender(<QueryClientProvider client={client}>{tree("other-branch")}</QueryClientProvider>);
  await screen.findByRole("option", { name: "已完成 · other · 稿件 v0" });
  await act(async () => resolve(page));
  expect(screen.queryByRole("option", { name: "已完成 · run-30 · 稿件 v0" })).not.toBeInTheDocument();
});
