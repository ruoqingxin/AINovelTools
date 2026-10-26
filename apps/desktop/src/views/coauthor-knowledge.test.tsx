import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoauthorKnowledge } from "./coauthor-knowledge";
import type { CoauthorEvidenceProgress, CoauthorKnowledgeEvidence, CoauthorScope, CoauthorSource } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope: CoauthorScope = { projectId: "p", sessionId: "s" };
const onRead = vi.fn();
const fact: CoauthorSource = {
  key: "FACT:one", kind: "FACT", title: "陆沉 · 掌握 · 魂灯", revision: "fact1", content: "审核记录",
  offset: 0, totalChars: 4, sessionId: null,
  knowledgeContext: {
    projectId: "p", version: 1, status: "CURRENT", facts: [], hasMoreAnchors: false, totalAnchors: 1,
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
const evidenceProgress: CoauthorEvidenceProgress = {
  id: "progress1", knowledgeKey: fact.key, knowledgeRevision: fact.revision, title: fact.title,
  listedAnchors: 1, totalAnchors: 1, validatedAnchors: 1, readAnchors: 1, sentAnchors: 0,
  stale: false, needsReview: false, allEvidenceSent: false, offset: 0, nextOffset: 1,
  entries: [{ anchor: fact.knowledgeContext!.anchors[0], totalChars: 8, readChars: 8, sentChars: 3,
    nextOffset: 3, readComplete: true, sentComplete: false }],
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
    ? structuredClone(evidence) : command === "get_coauthor_evidence_progress" ? structuredClone(evidenceProgress)
      : { execution: "RETURNED_PAGE", hits: [structuredClone(relation)], hasMore: false, pendingIndexUpdates: 0, coverage: "" });
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
    execution: "RETURNED_PAGE", hits: args.offset ? [] : [relation], hasMore: !args.offset, pendingIndexUpdates: 0, coverage: "",
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

const manyAnchors = {
  ...fact, knowledgeContext: {
    ...fact.knowledgeContext!, totalAnchors: 17, hasMoreAnchors: true,
    anchors: Array.from({ length: 16 }, (_, index) => ({
      ...fact.knowledgeContext!.anchors[0], id: `a${index}`, blockId: `p${index}`,
    })),
  },
};
const lastPage = {
  knowledgeKey: fact.key, knowledgeRevision: fact.revision, offset: 16, totalAnchors: 17, nextOffset: 17,
  anchors: [{ ...fact.knowledgeContext!.anchors[0], id: "a16", blockId: "p16" }],
};

it("pages the full evidence directory on demand without reading any manuscript automatically", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "list_coauthor_knowledge_anchors") return args.offset ? lastPage : {
      ...lastPage, offset: 0, nextOffset: 16, anchors: manyAnchors.knowledgeContext.anchors,
    };
    return { ...evidence, anchorId: "a16", content: "后续页原文" };
  });
  mount(manyAnchors);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.getByText("证据目录 · 1 至 16 / 17 条")).toBeVisible();
  expect(screen.getByText("还有证据未展示，目录状态不代表原文已核验。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "下一页证据" }));
  expect(await screen.findByText("正文证据 · p16")).toBeVisible();
  expect(screen.getByText("证据目录 · 17 至 17 / 17 条")).toBeVisible();
  expect(screen.queryByText("正文证据 · p0")).not.toBeInTheDocument();
  expect(screen.queryByText(/原文身份与范围已核验/)).not.toBeInTheDocument();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_knowledge_anchors", {
    scope, key: fact.key, revision: fact.revision, offset: 16,
  });
  expect(screen.getByRole("button", { name: "下一页证据" })).toBeDisabled();
  fireEvent.click(screen.getByText("正文证据 · p16"));
  expect(await screen.findByText("后续页原文")).toBeVisible();
  expect(mocks.invoke).toHaveBeenLastCalledWith("read_coauthor_knowledge_evidence", expect.objectContaining({
    key: fact.key, revision: fact.revision, anchorId: "a16",
  }));
  expect(screen.getByText("原文身份与范围已核验 · 本段 0 至 8 / 8 字符")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "上一页证据" }));
  expect(await screen.findByText("正文证据 · p0")).toBeVisible();
  expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_knowledge_anchors", expect.objectContaining({ offset: 0 }));
});

it("fails closed when an unseen anchor changes version, then can return to the earlier directory page", async () => {
  mocks.invoke.mockRejectedValue(new Error("证据版本已变化"));
  mount(manyAnchors);
  fireEvent.click(screen.getByRole("button", { name: "下一页证据" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("证据目录无法核实：证据版本已变化");
  expect(screen.getByRole("button", { name: "下一页证据" })).toBeDisabled();
  expect(screen.queryByText("正文证据 · p0")).not.toBeInTheDocument();
  mocks.invoke.mockResolvedValue({ ...lastPage, offset: 0, nextOffset: 16, anchors: manyAnchors.knowledgeContext.anchors });
  fireEvent.click(screen.getByRole("button", { name: "上一页证据" }));
  expect(await screen.findByText("正文证据 · p0")).toBeVisible();
  expect(mocks.invoke).toHaveBeenLastCalledWith("list_coauthor_knowledge_anchors", expect.objectContaining({
    revision: "fact1", offset: 0,
  }));
});

it("keeps a failed directory refresh visibly unverified and does not claim cached evidence is freshly checked", async () => {
  mocks.invoke.mockImplementation(async (command) => command === "list_coauthor_knowledge_anchors" ? lastPage : evidence);
  mount(manyAnchors);
  fireEvent.click(screen.getByRole("button", { name: "下一页证据" }));
  await screen.findByText("正文证据 · p16");
  fireEvent.click(screen.getByText("正文证据 · p16"));
  expect(await screen.findByText("原文身份与范围已核验 · 本段 0 至 8 / 8 字符")).toBeVisible();
  mocks.invoke.mockRejectedValue(new Error("来源已变化"));
  fireEvent.click(screen.getByRole("button", { name: "刷新证据目录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("来源已变化");
  expect(screen.getByText("以下为缓存目录，当前状态尚未核实。")).toBeVisible();
  expect(screen.getByText("正文证据 · p16")).toBeVisible();
  expect(screen.queryByText(/原文身份与范围已核验/)).not.toBeInTheDocument();
});

it("isolates late directory pages after source revision or branch changes", async () => {
  let resolve: (value: typeof lastPage) => void = () => {};
  mocks.invoke.mockImplementation(() => new Promise<typeof lastPage>((done) => { resolve = done; }));
  const { client, view } = mount(manyAnchors);
  fireEvent.click(screen.getByRole("button", { name: "下一页证据" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  const changed = { ...manyAnchors, revision: "fact2" };
  view.rerender(<QueryClientProvider client={client}>{tree(changed, { ...scope, sessionId: "other" })}</QueryClientProvider>);
  await act(async () => resolve(lastPage));
  expect(screen.getByText("证据目录 · 1 至 16 / 17 条")).toBeVisible();
  expect(screen.queryByText("正文证据 · p16")).not.toBeInTheDocument();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

function progressPanel() {
  return within(screen.getByText("模型证据进度", { exact: true }).closest("details")!);
}

it("restores model evidence progress only on expansion and does not equate author reading with delivery", async () => {
  mount();
  expect(mocks.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("模型证据进度"));
  expect(await progressPanel().findByText("独立证据 1 条")).toBeVisible();
  expect(progressPanel().getByText("执行读取 8 / 8 字符 · 模型送达 3 / 8 字符 · 连续送达至 3")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_evidence_progress", {
    scope, key: fact.key, revision: fact.revision, offset: 0,
  });
  fireEvent.click(progressPanel().getByText("正文证据 · p1"));
  expect(await progressPanel().findByText(evidence.content)).toBeVisible();
  expect(progressPanel().getByText("执行读取 8 / 8 字符 · 模型送达 3 / 8 字符 · 连续送达至 3")).toBeVisible();
  expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
    "get_coauthor_evidence_progress", "read_coauthor_knowledge_evidence",
  ]);
});

it("distinguishes a never-started evidence record from one with confirmed model receipts", async () => {
  mocks.invoke.mockResolvedValue({
    ...evidenceProgress, id: null, validatedAnchors: 0, readAnchors: 0, sentAnchors: 0,
    entries: [{ ...evidenceProgress.entries[0], totalChars: null, readChars: 0, sentChars: 0, nextOffset: 0 }],
  });
  mount();
  fireEvent.click(screen.getByText("模型证据进度"));
  expect(await progressPanel().findByText("尚无模型证据读取回执。")).toBeVisible();
  expect(progressPanel().getByText("原文尚未校验")).toBeVisible();
  expect(progressPanel().queryByText(/全部独立证据引句已送达过模型/)).not.toBeInTheDocument();
});

it("pages independent anchor coverage without automatically reading the next page of original quotes", async () => {
  mocks.invoke.mockImplementation(async (_command, args) => ({
    ...evidenceProgress, listedAnchors: 18, totalAnchors: 17, offset: args.offset,
    nextOffset: args.offset ? 17 : 16, entries: Array.from({ length: args.offset ? 1 : 16 }, (_, index) => ({
      ...evidenceProgress.entries[0], anchor: { ...fact.knowledgeContext!.anchors[0],
        id: `progress-${args.offset + index}`, blockId: `progress-block-${args.offset + index}` },
    })),
  }));
  mount();
  fireEvent.click(screen.getByText("模型证据进度"));
  await progressPanel().findByText("正文证据 · progress-block-0");
  fireEvent.click(progressPanel().getByRole("button", { name: "下一页证据进度" }));
  expect(await progressPanel().findByText("正文证据 · progress-block-16")).toBeVisible();
  expect(progressPanel().queryByText("正文证据 · progress-block-0")).not.toBeInTheDocument();
  expect(progressPanel().getByRole("button", { name: "下一页证据进度" })).toBeDisabled();
  expect(mocks.invoke).toHaveBeenLastCalledWith("get_coauthor_evidence_progress", expect.objectContaining({
    key: fact.key, revision: fact.revision, offset: 16,
  }));
  expect(mocks.invoke.mock.calls.every(([command]) => command === "get_coauthor_evidence_progress")).toBe(true);
});

it("keeps superseded coverage as history and never requests a substituted source revision", async () => {
  mocks.invoke.mockResolvedValue({ ...evidenceProgress, stale: true, sentAnchors: 1, allEvidenceSent: true });
  mount();
  fireEvent.click(screen.getByText("模型证据进度"));
  expect(await progressPanel().findByText("原依据已变化，以下是历史进度，不计入当前版本。")).toBeVisible();
  expect(progressPanel().queryByText(/全部独立证据引句已送达过模型/)).not.toBeInTheDocument();
  fireEvent.click(progressPanel().getByText("正文证据 · p1"));
  expect(await progressPanel().findByText("目录版本尚未核实，已有证据仅供历史对照。")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenLastCalledWith("get_coauthor_evidence_progress", expect.objectContaining({ revision: "fact1" }));
});

it("withdraws a cached complete-delivery status when refresh fails without clearing historical counts", async () => {
  mocks.invoke.mockResolvedValue({ ...evidenceProgress, sentAnchors: 1, allEvidenceSent: true });
  mount();
  fireEvent.click(screen.getByText("模型证据进度"));
  expect(await progressPanel().findByText("本版本全部独立证据引句已送达过模型，语义及适用条件仍待核对。")).toBeVisible();
  mocks.invoke.mockRejectedValue(new Error("进度存储暂不可读"));
  fireEvent.click(progressPanel().getByRole("button", { name: "刷新证据进度" }));
  expect(await progressPanel().findByRole("alert")).toHaveTextContent("进度存储暂不可读");
  expect(progressPanel().getByText("以下为缓存进度，当前状态尚未核实。")).toBeVisible();
  expect(progressPanel().queryByText(/全部独立证据引句已送达过模型/)).not.toBeInTheDocument();
  expect(progressPanel().getByText("执行读取 8 / 8 字符 · 模型送达 3 / 8 字符 · 连续送达至 3")).toBeVisible();
});

it("isolates delayed model progress after switching branches and source revisions", async () => {
  let resolve: (value: CoauthorEvidenceProgress) => void = () => {};
  mocks.invoke.mockImplementation((_command, args) => args.scope.sessionId === "s"
    ? new Promise<CoauthorEvidenceProgress>((done) => { resolve = done; })
    : Promise.resolve({ ...evidenceProgress, totalAnchors: 2, sentAnchors: 0 }));
  const { client, view } = mount();
  fireEvent.click(screen.getByText("模型证据进度"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  view.rerender(<QueryClientProvider client={client}>
    {tree({ ...fact, revision: "fact2" }, { ...scope, sessionId: "other" })}
  </QueryClientProvider>);
  fireEvent.click(screen.getByText("模型证据进度"));
  await progressPanel().findByText("独立证据 2 条 · 目录引用 1 次");
  await act(async () => resolve({ ...evidenceProgress, allEvidenceSent: true }));
  expect(progressPanel().queryByText(/全部独立证据引句已送达过模型/)).not.toBeInTheDocument();
  expect(mocks.invoke).toHaveBeenLastCalledWith("get_coauthor_evidence_progress", expect.objectContaining({
    scope: { ...scope, sessionId: "other" }, revision: "fact2",
  }));
});

it("reports missing progress storage as an error rather than claiming no evidence or no prior reading", async () => {
  mocks.invoke.mockRejectedValue(new Error("读取进度失败"));
  mount();
  fireEvent.click(screen.getByText("模型证据进度"));
  expect(await progressPanel().findByRole("alert")).toHaveTextContent("读取进度失败");
  expect(progressPanel().queryByText("尚无模型证据读取回执。")).not.toBeInTheDocument();
  expect(progressPanel().queryByText(/独立证据 0 条/)).not.toBeInTheDocument();
});
