import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChapterManuscript } from "./use-chapter-manuscript";

const mocks = vi.hoisted(() => ({
  currentManuscript: vi.fn(), listManuscriptRevisions: vi.fn(), listRecoveryLogs: vi.fn(),
  saveManuscriptChecked: vi.fn(), clearRecoveryLogs: vi.fn(), saveRecoveryLog: vi.fn(),
  enqueueChapterSummaryRefresh: vi.fn(), mergeManuscript: vi.fn(),
}));
const editorMock = vi.hoisted(() => ({
  getJSON: vi.fn(() => ({ type: "doc", content: [] })),
  commands: { setContent: vi.fn() },
}));
vi.mock("@tiptap/react", () => ({ useEditor: () => editorMock }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"),
  ...mocks,
}));

const documentJson = (text: string) => JSON.stringify({
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const revision = (id: string, text: string, chapterId = "chapter-1") => ({
  id, chapterId, documentJson: documentJson(text), parentRevisionId: null, createdAt: "", creationReason: "MANUAL_SAVE",
});

function setup(chapterId = "chapter-1", mode: "planning" | "writing" = "writing") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onError = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ chapterId, mode }) => useChapterManuscript({
    chapterId, projectId: "project-1", mode, onError,
  }), { wrapper, initialProps: { chapterId, mode } });
  return { ...hook, client, onError };
}

describe("useChapterManuscript", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentManuscript.mockResolvedValue(revision("revision-1", "saved"));
    mocks.listManuscriptRevisions.mockResolvedValue([revision("revision-1", "saved"), revision("revision-0", "old")]);
    mocks.listRecoveryLogs.mockResolvedValue([]);
    mocks.clearRecoveryLogs.mockResolvedValue(undefined);
    mocks.saveRecoveryLog.mockResolvedValue(undefined);
    mocks.saveManuscriptChecked.mockImplementation(({ documentJson }) => Promise.resolve({ ...revision("revision-2", ""), documentJson }));
    mocks.mergeManuscript.mockResolvedValue({ documentJson: documentJson("merged"), conflicts: [] });
  });

  it("does not load manuscript services in the planning workspace", () => {
    setup("chapter-1", "planning");
    expect(mocks.currentManuscript).not.toHaveBeenCalled();
    expect(mocks.listManuscriptRevisions).not.toHaveBeenCalled();
    expect(mocks.listRecoveryLogs).not.toHaveBeenCalled();
  });

  it("preserves unsaved candidates and their original baseline across background refetches", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => result.current.setDraft(documentJson("candidate")));
    act(() => client.setQueryData(["manuscript", "chapter-1"], revision("external-revision", "external")));
    await waitFor(() => expect(result.current.manuscript.data?.id).toBe("external-revision"));
    expect(result.current.draft).toBe(documentJson("candidate"));
    expect(result.current.chapterDirty).toBe(true);
    await act(() => result.current.saveDraft());
    expect(mocks.saveManuscriptChecked).toHaveBeenCalledWith(expect.objectContaining({
      baseRevisionId: "revision-1", documentJson: documentJson("candidate"),
    }));
  });

  it("refreshes an unchanged candidate when the saved version changes", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => client.setQueryData(["manuscript", "chapter-1"], revision("external-revision", "external")));
    await waitFor(() => expect(result.current.draft).toBe(documentJson("external")));
    expect(result.current.chapterDirty).toBe(false);
  });

  it("merges against the candidate's actual baseline rather than the saved revision's parent", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => result.current.setDraft(documentJson("candidate")));
    act(() => client.setQueryData(["manuscript", "chapter-1"], revision("external-revision", "external")));
    await waitFor(() => expect(result.current.manuscript.data?.id).toBe("external-revision"));
    await act(() => result.current.mergeDraft());
    expect(mocks.mergeManuscript).toHaveBeenCalledWith({
      base: documentJson("saved"), current: documentJson("external"), draft: documentJson("candidate"),
    });
  });

  it("loads transferred candidates only after the saved manuscript and project are ready", async () => {
    window.sessionStorage.setItem("ainoveltools:writing-candidate-transfer", JSON.stringify({
      projectId: "project-1", chapterId: "chapter-1", documentJson: documentJson("transferred"),
    }));
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("transferred")));
    expect(result.current.manuscriptTab).toBe("candidate");
    expect(result.current.chapterDirty).toBe(true);
    expect(window.sessionStorage.getItem("ainoveltools:writing-candidate-transfer")).toBeNull();
  });

  it("resets draft, merge and comparison state when changing chapters", async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => result.current.setManuscriptTab("versions"));
    await waitFor(() => expect(result.current.compareLeftId).toBe("revision-0"));
    mocks.currentManuscript.mockResolvedValue(revision("chapter-2-revision", "second", "chapter-2"));
    mocks.listManuscriptRevisions.mockResolvedValue([revision("chapter-2-revision", "second", "chapter-2")]);
    rerender({ chapterId: "chapter-2", mode: "writing" });
    await waitFor(() => expect(result.current.draft).toBe(documentJson("second")));
    expect(result.current.compareLeftId).toBeNull();
    expect(result.current.compareRightId).toBeNull();
    expect(result.current.mergeResult).toBeNull();
    expect(result.current.manuscriptTab).toBe("manuscript");
  });

  it("loads full version history only when opening the versions tab", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    expect(mocks.listManuscriptRevisions).not.toHaveBeenCalled();
    act(() => result.current.setManuscriptTab("versions"));
    await waitFor(() => expect(mocks.listManuscriptRevisions).toHaveBeenCalledWith("chapter-1"));
  });

  it("discards local candidates when leaving a chapter and reopening it", async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => result.current.setDraft(documentJson("discarded")));
    rerender({ chapterId: "", mode: "writing" });
    rerender({ chapterId: "chapter-1", mode: "writing" });
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    expect(result.current.chapterDirty).toBe(false);
  });

  it("does not discard edits made while a save is in progress", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => result.current.setDraft(documentJson("first edit")));
    let finishSave!: (value: ReturnType<typeof revision>) => void;
    mocks.saveManuscriptChecked.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveDraft(); });
    act(() => result.current.setDraft(documentJson("newer edit")));
    await act(async () => {
      finishSave(revision("revision-2", "first edit"));
      await saving;
    });
    expect(result.current.draft).toBe(documentJson("newer edit"));
    expect(result.current.chapterDirty).toBe(true);
  });
});
