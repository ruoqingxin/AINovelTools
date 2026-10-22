import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoauthorKnowledge } from "./coauthor-knowledge";
import type { CoauthorKnowledgeEvidence, CoauthorScope, CoauthorSource } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope: CoauthorScope = { projectId: "p", sessionId: "s" };
const onRead = vi.fn();
const fact: CoauthorSource = {
  key: "FACT:one", kind: "FACT", title: "陆沉 · 掌握 · 魂灯", revision: "fact1", content: "审核记录",
  offset: 0, totalChars: 4, sessionId: null,
  knowledgeContext: {
    projectId: "p", version: 1, status: "CURRENT", facts: [], hasMoreAnchors: false,
    anchors: [{ id: "a", chapterId: "chapter", revisionId: "m1", blockId: "p1", status: "CURRENT_REVISION" }],
  },
};
const relation: CoauthorSource = {
  ...fact, key: "RELATION:one", kind: "RELATION", title: "守护", revision: "relation1",
  knowledgeContext: {
    ...fact.knowledgeContext!, facts: [
      { key: fact.key, revision: fact.revision, title: fact.title },
      { key: "FACT:two", revision: "fact2", title: "苏瑶 · 守在 · 门外" },
    ],
  },
};
const evidence: CoauthorKnowledgeEvidence = {
  knowledgeKey: fact.key, knowledgeRevision: fact.revision, anchorId: "a", chapterId: "chapter",
  revisionId: "m1", blockId: "p1", start: 2, end: 10, content: "陆沉😀掌握魂灯。",
  offset: 0, nextOffset: 8, totalChars: 8, isCurrentRevision: true,
};
function tree(source = fact, selectedScope = scope) {
  return <CoauthorKnowledge key={`${selectedScope.projectId}:${selectedScope.sessionId}:${source.key}:${source.revision}`}
    scope={selectedScope} source={source} onRead={onRead} />;
}
function mount(source = fact) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{tree(source)}</QueryClientProvider>);
  return { client, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (command: string) => command === "read_coauthor_knowledge_evidence"
    ? structuredClone(evidence) : { hits: [structuredClone(relation)], hasMore: false, pendingIndexUpdates: 0, coverage: "" });
});
afterEach(cleanup);

it("shows record provenance without loading relationships or manuscript evidence while closed", () => {
  mount();
  expect(screen.getByText("已审核事实记录 · v1")).toBeVisible();
  expect(screen.getByText("原证据修订仍在用，原文范围与适用条件尚须核对。")).toBeVisible();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("reads exact paginated evidence only on expansion and links the original revision and block", async () => {
  mocks.invoke.mockImplementation(async (_command, args: { offset: number }) => ({
    ...evidence, offset: args.offset, nextOffset: args.offset ? 8 : 3, content: args.offset ? "掌握魂灯。" : "陆沉😀",
  }));
  mount();
  fireEvent.click(screen.getByText("正文证据 · p1"));
  expect(await screen.findByText("陆沉😀")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_knowledge_evidence", {
    scope, key: fact.key, revision: "fact1", anchorId: "a", offset: 0, limit: 2000,
  });
  expect(screen.getByText("块内字符 2 至 5")).toBeVisible();
  const href = new URL(screen.getByRole("link", { name: "定位原修订" }).getAttribute("href")!, "http://localhost");
  expect(href.searchParams.get("sourceEvidence")).toBe("a");
  expect(href.searchParams.get("sourceRevision")).toBe("m1");
  expect(href.searchParams.get("sourceBlock")).toBe("p1");
  fireEvent.click(screen.getByRole("button", { name: "下一段证据" }));
  expect(await screen.findByText("掌握魂灯。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenLastCalledWith("read_coauthor_knowledge_evidence", expect.objectContaining({ offset: 3 }));
});

it("marks stale facts and their preserved original quote as historical rather than current truth", async () => {
  mocks.invoke.mockResolvedValue({ ...evidence, isCurrentRevision: false });
  mount({ ...fact, knowledgeContext: { ...fact.knowledgeContext!, status: "NEEDS_REVIEW",
    anchors: [{ ...fact.knowledgeContext!.anchors[0], status: "STALE" }] } });
  expect(screen.getByText("依据待核对，不能直接当作当前有效结论。")).toBeVisible();
  fireEvent.click(screen.getByText("正文证据 · p1"));
  expect(await screen.findByText("历史原文，不代表当前正文仍采用此版本。")).toBeVisible();
  expect(screen.getByText("陆沉😀掌握魂灯。")).toBeVisible();
});

it("reports invalid evidence without substituting another quote or calling a model", async () => {
  mocks.invoke.mockRejectedValue(new Error("原文范围不符"));
  mount();
  fireEvent.click(screen.getByText("正文证据 · p1"));
  expect(await screen.findByRole("alert")).toHaveTextContent("原文范围不符");
  expect(screen.queryByRole("link", { name: "定位原修订" })).not.toBeInTheDocument();
  expect(mocks.invoke.mock.calls.every(([command]) => command === "read_coauthor_knowledge_evidence")).toBe(true);
});

it("pages direct relationships and opens their exact stable source identity without auto-reading all endpoints", async () => {
  mocks.invoke.mockImplementation(async (_command, args: { offset: number }) => ({
    hits: args.offset ? [] : [relation], hasMore: !args.offset, pendingIndexUpdates: 0, coverage: "",
  }));
  mount();
  fireEvent.click(screen.getByText("直接关联关系"));
  fireEvent.click(await screen.findByRole("button", { name: "查看关系记录" }));
  expect(onRead).toHaveBeenCalledWith("RELATION:one", "relation1");
  fireEvent.click(screen.getByRole("button", { name: "下一页关系" }));
  expect(await screen.findByText("此页没有直接关系记录，不代表没有其他影响。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_related_knowledge", {
    scope, key: fact.key, revision: fact.revision, offset: 12,
  });
  fireEvent.click(screen.getByRole("button", { name: "上一页关系" }));
  expect(await screen.findByText("守护")).toBeVisible();
});

it("follows explicit relation endpoints without inferring names or fetching unrelated fact records", () => {
  mount(relation);
  fireEvent.click(screen.getByRole("button", { name: "终点事实 · 苏瑶 · 守在 · 门外" }));
  expect(onRead).toHaveBeenCalledWith("FACT:two", "fact2");
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("keeps cached quotes visibly unverified after refresh failure and retries the same version", async () => {
  mount();
  fireEvent.click(screen.getByText("正文证据 · p1"));
  await screen.findByText("陆沉😀掌握魂灯。");
  mocks.invoke.mockRejectedValue(new Error("来源已变化"));
  fireEvent.click(screen.getByRole("button", { name: "刷新原文证据" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("来源已变化");
  expect(screen.getByText("以下为缓存证据，当前状态尚未核实。")).toBeVisible();
  expect(screen.getByText("陆沉😀掌握魂灯。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenLastCalledWith("read_coauthor_knowledge_evidence", expect.objectContaining({ revision: "fact1" }));
});

it("isolates a late evidence response when the author switches branches", async () => {
  let resolve: (value: CoauthorKnowledgeEvidence) => void = () => {};
  mocks.invoke.mockImplementation((_command, args: { scope: CoauthorScope }) => args.scope.sessionId === "s"
    ? new Promise<CoauthorKnowledgeEvidence>((done) => { resolve = done; })
    : Promise.resolve({ ...evidence, content: "另一分支证据" }));
  const { client, view } = mount();
  fireEvent.click(screen.getByText("正文证据 · p1"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  view.rerender(<QueryClientProvider client={client}>{tree(fact, { ...scope, sessionId: "other" })}</QueryClientProvider>);
  fireEvent.click(screen.getByText("正文证据 · p1"));
  await screen.findByText("另一分支证据");
  await act(async () => resolve(evidence));
  expect(screen.queryByText("陆沉😀掌握魂灯。")).not.toBeInTheDocument();
});
