import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoauthorChangeSet, CoauthorChangesPage, CoauthorDocument } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorChangesPanel } from "./coauthor-changes-panel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p1", sessionId: "s1" };
let document: CoauthorDocument;
let changes: CoauthorChangeSet;
let page: CoauthorChangesPage;
let generating: boolean;
const committed = vi.fn();

function renderPanel() {
  return render(<ConfirmActionProvider><CoauthorChangesPanel scope={scope}
    getDocument={() => document} saveDraft={async () => structuredClone(document)}
    isGenerating={() => generating} onCommitted={committed} /></ConfirmActionProvider>);
}
async function openReview() {
  fireEvent.click(await screen.findByRole("button", { name: "核对差异" }));
  return screen.findByRole("region", { name: "关联变更差异" });
}
async function confirmSelected() {
  fireEvent.click(screen.getByRole("button", { name: "确认采用所选变更" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "采用所选变更" }));
}
function receipt(): CoauthorChangeSet {
  return { ...changes, status: "COMMITTED", version: 2, selectedIds: ["draft", "realm"], published: [
    { itemId: "draft", sourceKey: "MANUSCRIPT:new", revision: "m2" },
    { itemId: "realm", sourceKey: "ENTITY:realm", revision: "r2" },
  ] };
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); generating = false;
  document = { sessionId: "s1", version: 3, kind: "MANUSCRIPT", title: "突破",
    content: "他忘了母亲的声音。", targetKey: null, targetRevision: null, narrativePosition: "金丹之后" };
  changes = {
    id: "c1", version: 1, title: "采用失忆版本", status: "PENDING", baseDocument: structuredClone(document),
    items: [
      { id: "draft", document: structuredClone(document), before: null, dependsOn: ["realm"],
        manuscriptEdits: [], manuscriptDraftVersion: null, manuscriptBeforeJson: null, manuscriptAfterJson: null,
        outlineEdits: [], outlineBefore: null, outlineFingerprint: null },
      { id: "realm", document: { ...document, kind: "SETTING", title: "修炼体系", content: "突破消耗记忆。",
        targetKey: "ENTITY:realm", targetRevision: "r1" }, before: {
        key: "ENTITY:realm", kind: "ENTITY", title: "旧修炼体系", revision: "r1",
        content: "突破消耗寿元。", sessionId: null, offset: 0, totalChars: 8,
      }, dependsOn: [], manuscriptEdits: [], manuscriptDraftVersion: null, manuscriptBeforeJson: null, manuscriptAfterJson: null,
      outlineEdits: [], outlineBefore: null, outlineFingerprint: null },
    ],
    impacts: [{ itemIds: ["realm"], key: "MANUSCRIPT:old", revision: "m1", quote: "他还记得声音", reason: "复查突破后描写" }],
    coverage: "仅查了体系与旧章，未检查全书", selectedIds: [], published: [], runId: "run1",
    undo: [], reversedBy: null, readDependencies: [],
  };
  page = {
    changeSets: [{ id: "c1", version: 1, title: changes.title, status: "PENDING", itemCount: 2, reversedBy: null }],
    impacts: [], hasMoreChanges: false, hasMoreImpacts: false,
  };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_coauthor_changes") return structuredClone(page);
    if (command === "get_coauthor_changeset") return structuredClone(changes);
    if (command === "commit_coauthor_changeset") return receipt();
    if (command === "prepare_coauthor_changeset") return structuredClone(changes);
    if (command === "discard_coauthor_changeset") return { ...changes, status: "DISCARDED", version: 2 };
    if (command === "update_coauthor_impact") return {};
    if (command === "get_coauthor_reversal") return null;
    throw new Error(`Unexpected command ${command}`);
  });
  committed.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("linked coauthor changes", () => {
  it("compares exact formal outline ranges, preserves candidate metadata and adopts no unrelated draft", async () => {
    changes.items = [{
      id: "outline", document: { ...document, kind: "OUTLINE", title: "突破大纲", content: "甲😀突破消耗记忆。\n结尾不变。",
        targetKey: "PLAN:plan-node:outline", targetRevision: "o1" },
      before: { key: "PLAN:plan-node:outline", kind: "PLAN", title: "突破大纲", revision: "o1",
        content: "规划状态：CONFIRMED\n当前记录：甲😀突破消耗寿元。\n候选稿：不要采用", offset: 0, totalChars: 44, sessionId: null },
      dependsOn: [], manuscriptEdits: [], manuscriptBeforeJson: null, manuscriptAfterJson: null, manuscriptDraftVersion: null,
      outlineEdits: [{ start: 6, end: 8, before: "寿元", after: "记忆" }], outlineFingerprint: "fingerprint",
      outlineBefore: { id: "plan-node:outline", version: 3, content: "甲😀突破消耗寿元。\n结尾不变。",
        pendingContent: "尚未采用的候选", storyState: "CONFIRMED", rationale: "作者原备注", consequence: "等待复查",
        references: ["原始引用"], updatedAt: "now" },
    }];
    changes.impacts = [];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => command === "commit_coauthor_changeset"
      ? { ...changes, status: "COMMITTED", version: 2, selectedIds: ["outline"],
        published: [{ itemId: "outline", sourceKey: "PLAN:plan-node:outline", revision: "o2" }] }
      : original(command, args));
    renderPanel(); await openReview();
    expect(screen.getByLabelText("局部修改前大纲")).toHaveTextContent("甲😀突破消耗寿元。");
    expect(screen.getByLabelText("局部修改前大纲")).not.toHaveTextContent("候选稿");
    expect(screen.getByLabelText("局部修改后大纲")).toHaveTextContent("甲😀突破消耗记忆。");
    expect(screen.getByRole("region", { name: "大纲局部修改范围" })).toHaveTextContent("字符 6 至 8");
    fireEvent.click(screen.getByText("保留的大纲记录 · v3"));
    expect(screen.getByText("尚未采用的候选")).toBeVisible();
    expect(screen.getByText("作者原备注")).toBeVisible();
    expect(screen.getByText("原始引用")).toBeVisible();
    await confirmSelected();
    await waitFor(() => expect(committed).toHaveBeenCalledWith(document, false));
    expect(mocks.invoke).toHaveBeenCalledWith("commit_coauthor_changeset", { scope, id: "c1", expectedVersion: 1, selectedIds: ["outline"] });
  });

  it("compares local manuscript ranges and rich formatting without adding the unrelated working draft", async () => {
    const rich = (text: string) => JSON.stringify({ type: "doc", content: [
      { type: "paragraph", attrs: { blockId: "p" }, content: [
        { type: "text", text, marks: [{ type: "bold" }] },
        { type: "text", text: "，保留斜体。", marks: [{ type: "italic" }] },
      ] },
    ] });
    changes.items = [{
      id: "patch", document: { ...document, title: "旧章", content: "甲😀失去记忆，保留斜体。",
        targetKey: "MANUSCRIPT:old", targetRevision: "r1" },
      before: { key: "MANUSCRIPT:old", kind: "MANUSCRIPT", title: "旧章", revision: "r1",
        content: "甲😀失去寿元，保留斜体。", offset: 0, totalChars: 13, sessionId: null },
      dependsOn: [], manuscriptEdits: [{ blockId: "p", start: 4, end: 6, before: "寿元", after: "记忆" }],
      manuscriptDraftVersion: 0, manuscriptBeforeJson: rich("甲😀失去寿元"), manuscriptAfterJson: rich("甲😀失去记忆"),
      outlineEdits: [], outlineBefore: null, outlineFingerprint: null,
    }];
    changes.impacts = [];
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_coauthor_changes") return page;
      if (command === "get_coauthor_changeset") return changes;
      if (command === "commit_coauthor_changeset") return { ...changes, status: "COMMITTED", version: 2,
        selectedIds: ["patch"], published: [{ itemId: "patch", sourceKey: "MANUSCRIPT:old", revision: "r2" }] };
      throw new Error(command);
    });
    renderPanel(); await openReview();
    const before = await screen.findByLabelText("局部修改前正文");
    const after = await screen.findByLabelText("局部修改后正文");
    expect(before.querySelector("strong")).toHaveTextContent("甲😀失去寿元");
    expect(after.querySelector("strong")).toHaveTextContent("甲😀失去记忆");
    expect(after.querySelector("em")).toHaveTextContent("，保留斜体。");
    expect(after).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("region", { name: "正文局部修改范围" })).toHaveTextContent("字符 4 至 6");
    expect(screen.queryByText(/完整替换会重置/)).not.toBeInTheDocument();
    await confirmSelected();
    await waitFor(() => expect(committed).toHaveBeenCalledWith(document, false));
    expect(mocks.invoke).toHaveBeenCalledWith("commit_coauthor_changeset", {
      scope, id: "c1", expectedVersion: 1, selectedIds: ["patch"],
    });
  });

  it("shows actual before and after and commits only after explicit group confirmation", async () => {
    renderPanel();
    const review = await openReview();
    expect(within(review).getByText("突破消耗寿元。")).toBeVisible();
    expect(within(review).getByText("突破消耗记忆。")).toBeVisible();
    expect(within(review).getByText("仅查了体系与旧章，未检查全书")).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "commit_coauthor_changeset")).toBe(false);
    await confirmSelected();
    await waitFor(() => expect(committed).toHaveBeenCalledWith(document, true));
    expect(mocks.invoke).toHaveBeenCalledWith("commit_coauthor_changeset", {
      scope, id: "c1", expectedVersion: 1, selectedIds: ["draft", "realm"],
    });
    expect(await screen.findByText("已正式采用 2 项；其他内容未同步。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认采用所选变更" })).not.toBeInTheDocument();
  });

  it("blocks a subset missing dependencies and permits adopting just its independent setting", async () => {
    renderPanel(); await openReview();
    fireEvent.click(screen.getByRole("checkbox", { name: "修炼体系 设定" }));
    expect(screen.getByRole("button", { name: "确认采用所选变更" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("依赖未勾选的变更");
    fireEvent.click(screen.getByRole("checkbox", { name: "突破 正文" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "修炼体系 设定" }));
    expect(screen.getByRole("button", { name: "确认采用所选变更" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认采用所选变更" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/提交以下 1 项：修炼体系/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "采用所选变更" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("commit_coauthor_changeset", {
      scope, id: "c1", expectedVersion: 1, selectedIds: ["realm"],
    }));
    expect(committed).toHaveBeenCalledWith(document, false);
  });

  it("revokes confirmation after author editing and never submits unseen differences", async () => {
    renderPanel(); await openReview();
    fireEvent.click(screen.getByRole("button", { name: "确认采用所选变更" }));
    const dialog = await screen.findByRole("alertdialog");
    document = { ...document, content: "作者的新结尾。" };
    fireEvent.click(within(dialog).getByRole("button", { name: "采用所选变更" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("旧确认已失效");
    expect(mocks.invoke.mock.calls.some(([name]) => name === "commit_coauthor_changeset")).toBe(false);
  });

  it("blocks stale base versions and active generation before confirmation", async () => {
    renderPanel(); await openReview();
    document = { ...document, version: 4 };
    fireEvent.click(screen.getByRole("button", { name: "确认采用所选变更" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不再基于当前版本");
    document = { ...changes.baseDocument }; generating = true;
    fireEvent.click(screen.getByRole("button", { name: "确认采用所选变更" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("请先停止生成"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("recovers a lost commit response by querying the durable receipt without resubmitting", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let serverCommitted = false;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "commit_coauthor_changeset") { serverCommitted = true; throw new Error("响应丢失"); }
      if (command === "get_coauthor_changeset" && serverCommitted) return receipt();
      return original(command, args);
    });
    renderPanel(); await openReview(); await confirmSelected();
    expect(await screen.findByText("已正式采用 2 项；其他内容未同步。")).toBeVisible();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "commit_coauthor_changeset")).toHaveLength(1);
    expect(committed).toHaveBeenCalledOnce();
  });

  it("does not describe an unknown commit state as a known failure or silently retry it", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "commit_coauthor_changeset") throw new Error("连接中断");
      return original(command, args);
    });
    renderPanel(); await openReview(); await confirmSelected();
    expect(await screen.findByRole("alert")).toHaveTextContent("提交状态需重新核对");
    expect(committed).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "commit_coauthor_changeset")).toHaveLength(1);
  });

  it("requires a reason to resolve an impact and sends its version without changing formal text", async () => {
    page.impacts = [{
      id: "i1", version: 2, changeSetId: "c1", title: "旧章", evidence: changes.impacts[0],
      status: "PENDING", resolution: "", sourceChanged: true, originReversed: false,
    }];
    renderPanel();
    expect(await screen.findByText(/依据已变更或不可用/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "处理待办" }));
    expect(screen.getByRole("button", { name: "保存处理" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("待办状态"), { target: { value: "ACCEPTED_DIFFERENCE" } });
    fireEvent.change(screen.getByLabelText("待办处理依据"), { target: { value: "保留为不可靠叙述。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存处理" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_coauthor_impact", {
      scope, id: "i1", expectedVersion: 2, status: "ACCEPTED_DIFFERENCE", resolution: "保留为不可靠叙述。",
    }));
    expect(mocks.invoke.mock.calls.some(([name]) => name === "commit_coauthor_changeset")).toBe(false);
  });

  it("prepares current manuscript plus a new setting with an explicit dependency and no formal write", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("准备新的变更集"));
    fireEvent.click(screen.getByLabelText("同时新建设定"));
    fireEvent.change(screen.getByLabelText("关联设定标题"), { target: { value: "照魂境" } });
    fireEvent.change(screen.getByLabelText("关联设定内容"), { target: { value: "金丹之后，突破会失忆。" } });
    fireEvent.click(screen.getByRole("button", { name: "从当前工作稿准备" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("prepare_coauthor_changeset", {
      scope, request: {
        expectedDocumentVersion: 3, title: "突破与照魂境", draftDependsOn: ["setting"],
        items: [{ id: "setting", kind: "SETTING", title: "照魂境", content: "金丹之后，突破会失忆。",
          targetKey: null, targetRevision: null, dependsOn: [] }],
        impacts: [], coverage: "作者手动准备当前稿件；未检索其他章节、设定或伏笔的影响。",
      },
    }));
    expect(mocks.invoke.mock.calls.some(([name]) => name === "commit_coauthor_changeset")).toBe(false);
  });

  it("does not submit after the changes panel has been unmounted during confirmation", async () => {
    const view = renderPanel(); await openReview();
    fireEvent.click(screen.getByRole("button", { name: "确认采用所选变更" }));
    await screen.findByRole("alertdialog");
    view.unmount();
    await act(async () => {});
    expect(mocks.invoke.mock.calls.some(([name]) => name === "commit_coauthor_changeset")).toBe(false);
  });

  it("preserves unsubmitted related-setting input across panel remounts without crossing projects", async () => {
    const view = renderPanel();
    fireEvent.click(await screen.findByText("准备新的变更集"));
    fireEvent.click(screen.getByLabelText("同时新建设定"));
    fireEvent.change(screen.getByLabelText("关联设定标题"), { target: { value: "还没写完的设定" } });
    fireEvent.change(screen.getByLabelText("关联设定内容"), { target: { value: "失去某一段记忆" } });
    view.unmount();
    renderPanel();
    fireEvent.click(await screen.findByText("准备新的变更集"));
    expect(screen.getByLabelText("关联设定标题")).toHaveValue("还没写完的设定");
    expect(screen.getByLabelText("关联设定内容")).toHaveValue("失去某一段记忆");
    expect(localStorage.getItem("coauthor-change-form:p2:s1")).toBeNull();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "prepare_coauthor_changeset")).toBe(false);
  });

  it("discards a pending proposal only after confirmation and preserves its original content", async () => {
    renderPanel(); await openReview();
    fireEvent.click(screen.getByRole("button", { name: "放弃此方案" }));
    const dialog = await screen.findByRole("alertdialog", { name: "放弃关联变更" });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "discard_coauthor_changeset")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "放弃此方案" }));
    expect(await screen.findByText("此方案已放弃，原方案保留，正式内容未变更。")).toBeVisible();
    expect(screen.getByText("突破消耗记忆。")).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith("discard_coauthor_changeset", { scope, id: "c1", expectedVersion: 1 });
    expect(screen.queryByRole("button", { name: "确认采用所选变更" })).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "commit_coauthor_changeset")).toBe(false);
  });

  it("opens impact evidence using its exact source identity and revision", async () => {
    page.impacts = [{
      id: "i1", version: 1, changeSetId: "c1", title: "旧章", evidence: changes.impacts[0],
      status: "PENDING", resolution: "", sourceChanged: false, originReversed: false,
    }];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => command === "read_coauthor_source"
      ? { key: "MANUSCRIPT:old", kind: "MANUSCRIPT", title: "旧章", revision: "m1",
        content: "旧章完整引文：他还记得声音", sessionId: null, offset: 0, totalChars: 13 }
      : original(command, args));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "查看引用原文" }));
    expect(await screen.findByRole("region", { name: "影响引用原文" })).toHaveTextContent("旧章完整引文");
    expect(mocks.invoke).toHaveBeenCalledWith("read_coauthor_source", {
      scope, key: "MANUSCRIPT:old", revision: "m1", offset: 0,
    });
  });
});
