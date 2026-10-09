import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChapterDraftWriter } from "./chapter-draft-writer";
import type { ManuscriptDraft } from "./tauri-client";

const mocks = vi.hoisted(() => ({
  saveManuscriptDraft: vi.fn(), commitManuscriptDraft: vi.fn(), discardManuscriptDraft: vi.fn(),
}));
vi.mock("./tauri-client", () => mocks);
const initial: ManuscriptDraft = { chapterId: "chapter", documentJson: null, baseRevisionId: null, baseDocumentJson: "", version: 0, updatedAt: "" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveManuscriptDraft.mockImplementation((input) => Promise.resolve({ ...initial, ...input, version: input.expectedVersion + 1, baseRevisionId: input.baseRevisionId ?? null }));
  mocks.discardManuscriptDraft.mockImplementation((input) => Promise.resolve({ ...initial, version: input.expectedVersion + 1 }));
  mocks.commitManuscriptDraft.mockImplementation((input) => Promise.resolve({ revision: { id: "revision" }, draft: { ...initial, version: input.expectedVersion + 1 } }));
});

describe("chapter draft writer", () => {
  it("serializes autosaves with their acknowledged versions", async () => {
    const writer = createChapterDraftWriter(initial);
    await Promise.all([writer.save({ documentJson: "first" }), writer.save({ documentJson: "second" })]);
    expect(mocks.saveManuscriptDraft.mock.calls.map(([input]) => input.expectedVersion)).toEqual([0, 1]);
    expect(writer.current().documentJson).toBe("second");
  });

  it("commits the submitted snapshot after pending autosaves and skips identical writes", async () => {
    const writer = createChapterDraftWriter(initial);
    await Promise.all([writer.save({ documentJson: "first" }), writer.commit({ documentJson: "second", baseRevisionId: "base" })]);
    expect(mocks.commitManuscriptDraft).toHaveBeenCalledWith({ chapterId: "chapter", documentJson: "second", baseRevisionId: "base", expectedVersion: 2 });
    expect(writer.current().documentJson).toBeNull();
    await writer.save({ documentJson: "third" });
    await writer.save({ documentJson: "third" });
    expect(mocks.saveManuscriptDraft).toHaveBeenCalledTimes(3);
  });

  it("retains the version on rejection and continues the queue for a retry", async () => {
    const writer = createChapterDraftWriter(initial);
    mocks.saveManuscriptDraft.mockRejectedValueOnce(new Error("conflict"));
    await expect(writer.save({ documentJson: "first" })).rejects.toThrow("conflict");
    await writer.save({ documentJson: "retry" });
    expect(mocks.saveManuscriptDraft.mock.calls.map(([input]) => input.expectedVersion)).toEqual([0, 0]);
    await writer.discard();
    expect(writer.current().version).toBe(2);
  });
});
