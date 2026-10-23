import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoauthorChangeSet, CoauthorDocument, CoauthorReversal } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorReversalPanel } from "./coauthor-reversal-panel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope = { projectId: "p1", sessionId: "s1" };
let document: CoauthorDocument;
let changes: CoauthorChangeSet;
let preview: CoauthorReversal;
let stored: CoauthorReversal | null;
let generating: boolean;
const reversed = vi.fn();
const saveDraft = vi.fn();

function renderPanel() {
  return render(<ConfirmActionProvider><CoauthorReversalPanel scope={scope} changes={changes}
    disabled={false} getDocument={() => document} saveDraft={saveDraft}
    isGenerating={() => generating} onReversed={reversed} /></ConfirmActionProvider>);
}
async function prepare() {
  fireEvent.click(await screen.findByRole("button", { name: "核对整组撤销" }));
  await screen.findByRole("button", { name: "确认撤销本次全部采用" });
}
async function openConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: "确认撤销本次全部采用" }));
  return screen.findByRole("alertdialog");
}
function calls(command: string) { return mocks.invoke.mock.calls.filter(([name]) => name === command); }
beforeEach(() => {
  vi.clearAllMocks(); stored = null; generating = false;
  document = { sessionId: "s1", version: 4, kind: "MANUSCRIPT", title: "突破",
    content: "他忘了母亲的声音。", targetKey: "MANUSCRIPT:new", targetRevision: "m2", narrativePosition: "" };
  changes = { id: "c1", version: 2, title: "采用突破版本", status: "COMMITTED", baseDocument: { ...document, version: 3 },
    items: [], impacts: [], coverage: "未检查全书", selectedIds: ["draft"], runId: null,
    published: [{ itemId: "draft", sourceKey: "MANUSCRIPT:new", revision: "m2" }],
    undo: [], reversedBy: null, readDependencies: [], decisionDependencies: [] };
  preview = { id: "reverse1", changeSetId: "c1", version: 1, status: "PENDING", baseDocument: structuredClone(document),
    items: [{ itemId: "draft", title: "突破", sourceKey: "MANUSCRIPT:new", action: "ARCHIVE",
      before: { key: "MANUSCRIPT:new", kind: "MANUSCRIPT", title: "突破", revision: "m2",
        content: document.content, totalChars: 10, offset: 0, sessionId: null },
      after: null, beforeDocumentJson: null, afterDocumentJson: null, resultRevision: null }],
    blockers: [], impactCount: 2, linkedDraft: true };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_coauthor_reversal") return structuredClone(stored);
    if (command === "prepare_coauthor_reversal") { stored = structuredClone(preview); return stored; }
    if (command === "commit_coauthor_reversal") {
      stored = { ...preview, status: "COMMITTED", version: 2 }; return structuredClone(stored);
    }
    throw new Error(command);
  });
  reversed.mockResolvedValue(undefined);
  saveDraft.mockImplementation(async () => structuredClone(document));
});
afterEach(cleanup);

describe("author-confirmed whole-group reversal", () => {
  it("saves and previews the actual adopted subset, then requires explicit group confirmation", async () => {
    renderPanel(); await prepare();
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("prepare_coauthor_reversal",
      { scope, id: "c1", expectedVersion: 2, expectedDocumentVersion: 4 });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(calls("commit_coauthor_reversal")).toHaveLength(0);
    const dialog = await openConfirmation();
    expect(dialog).toHaveTextContent("全部 1 项");
    expect(dialog).toHaveTextContent("2 项影响待办");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认整组撤销" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已整组撤销");
    expect(mocks.invoke).toHaveBeenCalledWith("commit_coauthor_reversal", { scope, id: "c1", expectedVersion: 1 });
    expect(reversed).toHaveBeenCalledWith(document, true);
  });

  it("shows blockers without offering an executable reversal", async () => {
    preview.blockers = ["后续采用依赖当前修订，需要先处理。"];
    renderPanel(); await prepare();
    expect(screen.getByRole("alert")).toHaveTextContent("后续采用依赖");
    expect(screen.getByRole("button", { name: "确认撤销本次全部采用" })).toBeDisabled();
    expect(calls("commit_coauthor_reversal")).toHaveLength(0);
  });

  it("invalidates confirmation when author edits or generation starts during the dialog", async () => {
    renderPanel(); await prepare();
    const dialog = await openConfirmation();
    document = { ...document, content: "作者接着写了新句。" }; generating = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "确认整组撤销" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("旧撤销确认已失效");
    expect(calls("commit_coauthor_reversal")).toHaveLength(0);
  });

  it("blocks stale local drafts before confirmation and generation before preparation", async () => {
    renderPanel(); await prepare();
    document = { ...document, version: 5 };
    fireEvent.click(screen.getByRole("button", { name: "确认撤销本次全部采用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("工作稿已变化");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    generating = true;
    fireEvent.click(screen.getByRole("button", { name: "重新检查撤销" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("请先停止生成"));
    expect(calls("prepare_coauthor_reversal")).toHaveLength(1);
  });

  it("does not prepare if the draft changes while saving", async () => {
    saveDraft.mockImplementation(async () => { const saved = { ...document }; document = { ...document, content: "新编辑" }; return saved; });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "核对整组撤销" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("工作稿仍在变化");
    expect(calls("prepare_coauthor_reversal")).toHaveLength(0);
  });

  it("recovers a lost response only from the matching durable receipt without resubmission", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "commit_coauthor_reversal") {
        stored = { ...preview, status: "COMMITTED", version: 2 }; throw new Error("响应丢失");
      }
      return original(command, args);
    });
    renderPanel(); await prepare();
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认整组撤销" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已整组撤销");
    expect(calls("commit_coauthor_reversal")).toHaveLength(1);
    expect(reversed).toHaveBeenCalledOnce();
  });

  it("does not accept a different or uncommitted receipt as a successful reversal", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "commit_coauthor_reversal") {
        stored = { ...preview, id: "different", status: "COMMITTED", version: 2 }; throw new Error("断开");
      }
      return original(command, args);
    });
    renderPanel(); await prepare();
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认整组撤销" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("撤销状态需重新核对");
    expect(reversed).not.toHaveBeenCalled();
    expect(calls("commit_coauthor_reversal")).toHaveLength(1);
  });

  it("retrieves a committed receipt on remount and never offers to reverse it twice", async () => {
    stored = { ...preview, status: "COMMITTED", version: 2 };
    renderPanel();
    expect(await screen.findByRole("status")).toHaveTextContent("已整组撤销");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("get_coauthor_reversal", { scope, id: "c1" });
    expect(calls("commit_coauthor_reversal")).toHaveLength(0);
  });

  it("does not submit when the panel unmounts during confirmation", async () => {
    const view = renderPanel(); await prepare(); await openConfirmation();
    view.unmount(); await act(async () => {});
    expect(calls("commit_coauthor_reversal")).toHaveLength(0);
    expect(reversed).not.toHaveBeenCalled();
  });

  it("does not replace a new preview with a late initial query result", async () => {
    let resolveInitial!: (value: null) => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => command === "get_coauthor_reversal"
      ? new Promise<null>((resolve) => { resolveInitial = resolve; }) : original(command, args));
    renderPanel(); await prepare();
    await act(async () => resolveInitial(null));
    expect(screen.getByRole("button", { name: "确认撤销本次全部采用" })).toBeVisible();
  });
});
