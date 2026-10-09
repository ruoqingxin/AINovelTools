import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChapterManuscript } from "./use-chapter-manuscript";
import type { ManuscriptDraft, ManuscriptDraftCommit } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({
  currentManuscript: vi.fn(), listManuscriptRevisions: vi.fn(), listRecoveryLogs: vi.fn(),
  currentManuscriptDraft: vi.fn(), saveManuscriptDraft: vi.fn(), commitManuscriptDraft: vi.fn(),
  discardManuscriptDraft: vi.fn(), clearRecoveryLogs: vi.fn(), saveRecoveryLog: vi.fn(),
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
  id, chapterId, documentJson: documentJson(text), parentRevisionId: null, baseRevisionId: null,
  contentHash: id, documentSchemaVersion: 1, createdAt: "", creationReason: "MANUAL_SAVE",
});
const emptyDraft = (chapterId = "chapter-1", version = 0): ManuscriptDraft => ({
  chapterId, version, documentJson: null, baseRevisionId: null, baseDocumentJson: "", updatedAt: "",
});
let drafts: Map<string, ManuscriptDraft>;

function setup(chapterId = "chapter-1", mode: "planning" | "writing" = "writing", initialTab: "candidate" | "manuscript" = "manuscript") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onError = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ chapterId, mode }) => useChapterManuscript({
    chapterId, projectId: "project-1", mode, onError, initialTab,
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
    drafts = new Map();
    mocks.currentManuscript.mockResolvedValue(revision("revision-1", "saved"));
    mocks.listManuscriptRevisions.mockResolvedValue([revision("revision-1", "saved"), revision("revision-0", "old")]);
    mocks.listRecoveryLogs.mockResolvedValue([]);
    mocks.clearRecoveryLogs.mockResolvedValue(undefined);
    mocks.saveRecoveryLog.mockResolvedValue(undefined);
    mocks.currentManuscriptDraft.mockImplementation((chapterId) => Promise.resolve(drafts.get(chapterId) ?? emptyDraft(chapterId)));
    mocks.saveManuscriptDraft.mockImplementation(({ chapterId, documentJson, baseRevisionId, expectedVersion }) => {
      const saved = { chapterId, documentJson, baseRevisionId: baseRevisionId ?? null, baseDocumentJson: "", version: expectedVersion + 1, updatedAt: "" };
      saved.baseDocumentJson = revision("revision-1", "saved").documentJson;
      drafts.set(chapterId, saved);
      return Promise.resolve(saved);
    });
    mocks.commitManuscriptDraft.mockImplementation(({ chapterId, documentJson, expectedVersion }) => {
      const saved = { ...revision("revision-2", "", chapterId), documentJson };
      mocks.currentManuscript.mockResolvedValue(saved);
      const draft = emptyDraft(chapterId, expectedVersion + 1);
      drafts.set(chapterId, draft);
      return Promise.resolve({ revision: saved, draft });
    });
    mocks.discardManuscriptDraft.mockImplementation(({ chapterId, expectedVersion }) => {
      const draft = emptyDraft(chapterId, expectedVersion + 1);
      drafts.set(chapterId, draft);
      return Promise.resolve(draft);
    });
    mocks.mergeManuscript.mockResolvedValue({ documentJson: documentJson("merged"), conflicts: [] });
  });

  it("does not load manuscript services in the planning workspace", () => {
    setup("chapter-1", "planning");
    expect(mocks.currentManuscript).not.toHaveBeenCalled();
    expect(mocks.listManuscriptRevisions).not.toHaveBeenCalled();
    expect(mocks.listRecoveryLogs).not.toHaveBeenCalled();
  });

  it("opens and changes chapters directly in the shared editing workspace", async () => {
    const { result, rerender } = setup("chapter-1", "writing", "candidate");
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    expect(result.current.manuscriptTab).toBe("candidate");
    act(() => result.current.setManuscriptTab("manuscript"));
    mocks.currentManuscript.mockResolvedValue(revision("chapter-2-revision", "second", "chapter-2"));
    rerender({ chapterId: "chapter-2", mode: "writing" });
    await waitFor(() => expect(result.current.draft).toBe(documentJson("second")));
    expect(result.current.manuscriptTab).toBe("candidate");
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
    expect(mocks.commitManuscriptDraft).toHaveBeenCalledWith(expect.objectContaining({
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
    let finishSave!: (value: ManuscriptDraftCommit) => void;
    mocks.commitManuscriptDraft.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveDraft(); });
    await waitFor(() => expect(mocks.commitManuscriptDraft).toHaveBeenCalled());
    act(() => result.current.setDraft(documentJson("newer edit")));
    await act(async () => {
      finishSave({ revision: revision("revision-2", "first edit"), draft: emptyDraft("chapter-1", 2) });
      await saving;
    });
    expect(result.current.draft).toBe(documentJson("newer edit"));
    expect(result.current.chapterDirty).toBe(true);
  });

  it("preserves the draft and baseline when the backend rejects a stale save", async () => {
    const { result, onError } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    act(() => result.current.setDraft(documentJson("local draft")));
    mocks.commitManuscriptDraft.mockRejectedValueOnce(new Error("正文版本冲突"));
    await act(() => result.current.saveDraft());
    expect(onError).toHaveBeenLastCalledWith("正文版本冲突");
    expect(result.current.draft).toBe(documentJson("local draft"));
    expect(result.current.chapterDirty).toBe(true);
    expect(mocks.clearRecoveryLogs).not.toHaveBeenCalled();
    await act(() => result.current.saveDraft());
    expect(mocks.commitManuscriptDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      baseRevisionId: "revision-1", documentJson: documentJson("local draft"),
    }));
  });

  it("refreshes linked memory, review and search queries after a checked save", async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("saved")));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => result.current.setDraft(documentJson("new manuscript")));
    await act(() => result.current.saveDraft());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["manuscript", "chapter-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["summary-materials"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai-proposals", "chapter-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["project-search"] });
  });

  it("autosaves independently of formal revisions and restores a persisted draft on reopening", async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    act(() => result.current.setDraft(documentJson("persistent draft")));
    await waitFor(() => expect(result.current.draftNeedsPersistence).toBe(false), { timeout: 2500 });
    expect(mocks.saveManuscriptDraft).toHaveBeenCalledWith(expect.objectContaining({ baseRevisionId: "revision-1" }));
    expect(mocks.commitManuscriptDraft).not.toHaveBeenCalled();
    expect(mocks.saveRecoveryLog).not.toHaveBeenCalled();
    rerender({ chapterId: "chapter-2", mode: "writing" });
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    rerender({ chapterId: "chapter-1", mode: "writing" });
    await waitFor(() => expect(result.current.draft).toBe(documentJson("persistent draft")));
    expect(result.current.chapterDirty).toBe(true);
  });

  it("restores the original baseline even when the formal revision changed while closed", async () => {
    drafts.set("chapter-1", { ...emptyDraft(), documentJson: documentJson("local"), baseRevisionId: "revision-0", baseDocumentJson: documentJson("old"), version: 2 });
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).toBe(documentJson("local")));
    await act(() => result.current.mergeDraft());
    expect(mocks.mergeManuscript).toHaveBeenCalledWith({ base: documentJson("old"), current: documentJson("saved"), draft: documentJson("local") });
  });

  it("retains dirty content and exposes retry when draft persistence fails", async () => {
    mocks.saveManuscriptDraft.mockRejectedValueOnce(new Error("草稿版本冲突"));
    const { result } = setup();
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    act(() => result.current.setDraft(documentJson("local")));
    await act(() => result.current.persistLocalDraft());
    expect(result.current.draftStorageError).toBe("草稿版本冲突");
    expect(result.current.draftNeedsPersistence).toBe(true);
    await act(() => result.current.persistLocalDraft());
    expect(result.current.draftStorageError).toBeNull();
    expect(result.current.draftNeedsPersistence).toBe(false);
  });

  it("does not erase edits entered while discard is awaiting the backend", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let finish!: (value: ManuscriptDraft) => void;
    mocks.discardManuscriptDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = setup();
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    act(() => result.current.setDraft(documentJson("discard me")));
    let operation!: Promise<void>;
    act(() => { operation = result.current.discardLocalDraft(); });
    await waitFor(() => expect(mocks.discardManuscriptDraft).toHaveBeenCalled());
    act(() => result.current.setDraft(documentJson("keep new edit")));
    await act(async () => { finish(emptyDraft("chapter-1", 1)); await operation; });
    expect(result.current.draft).toBe(documentJson("keep new edit"));
    expect(result.current.draftNeedsPersistence).toBe(true);
  });

  it("does not silently replace new typing during a draft reload", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result, onError } = setup();
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    act(() => result.current.setDraft(documentJson("before reload")));
    let finish!: (value: ManuscriptDraft) => void;
    mocks.currentManuscriptDraft.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let operation!: Promise<void>;
    act(() => { operation = result.current.reloadLocalDraft(); });
    await waitFor(() => expect(mocks.currentManuscriptDraft).toHaveBeenCalledTimes(2));
    act(() => result.current.setDraft(documentJson("new typing")));
    await act(async () => { finish(emptyDraft()); await operation; });
    expect(result.current.draft).toBe(documentJson("new typing"));
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("新编辑"));
  });

  it("keeps initialized content and unsaved protection when a background draft read fails", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draftReady).toBe(true));
    act(() => result.current.setDraft(documentJson("not persisted")));
    mocks.currentManuscriptDraft.mockRejectedValueOnce(new Error("read failed"));
    await act(() => result.current.localDraft.refetch());
    await waitFor(() => expect(result.current.localDraft.isError).toBe(true));
    expect(result.current.draftReady).toBe(true);
    expect(result.current.draftNeedsPersistence).toBe(true);
    expect(result.current.draft).toBe(documentJson("not persisted"));
  });
});
