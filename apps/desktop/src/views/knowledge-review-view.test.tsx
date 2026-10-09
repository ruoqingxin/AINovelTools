import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReviewView } from "./knowledge-review-view";

const mocks = vi.hoisted(() => ({
  listPlanNodes: vi.fn(), listKnowledgeCandidates: vi.fn(), detectCandidateConflicts: vi.fn(),
  listEvidenceAnchors: vi.fn(), listManuscriptRevisions: vi.fn(), reviewKnowledgeCandidate: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));

describe("knowledge evidence query budget", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPlanNodes.mockResolvedValue([{ id: "chapter-1", kind: "CHAPTER", title: "入城" }]);
    mocks.listKnowledgeCandidates.mockResolvedValue([{
      id: "candidate-1", candidateStatus: "PENDING",
      fact: { subject: "沈砚", predicate: "进入", object: "雾城", evidenceAnchorIds: ["anchor-1"] },
    }]);
    mocks.detectCandidateConflicts.mockResolvedValue([]);
    mocks.listEvidenceAnchors.mockResolvedValue([{
      id: "anchor-1", chapterId: "chapter-1", sourceRevisionId: "original-revision", sourceVersion: "manuscript:original-revision", blockId: "original-block",
    }]);
    mocks.listManuscriptRevisions.mockResolvedValue([
      { id: "current-revision", documentJson: JSON.stringify({ content: [{ attrs: { blockId: "original-block" }, content: [{ text: "新修订，不是候选证据" }] }] }) },
      { id: "original-revision", documentJson: JSON.stringify({ content: [{ attrs: { blockId: "original-block" }, content: [{ text: "候选绑定的原修订证据" }] }] }) },
    ]);
  });

  it("fetches history only on expansion and uses the bound revision, not the latest text", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KnowledgeReviewView embedded chapterId="chapter-1" />
    </QueryClientProvider>);
    const summary = await screen.findByText("查看原文证据");
    expect(mocks.listManuscriptRevisions).not.toHaveBeenCalled();
    fireEvent.click(summary);
    expect(await screen.findByText("候选绑定的原修订证据")).toBeVisible();
    expect(screen.queryByText("新修订，不是候选证据")).not.toBeInTheDocument();
    expect(mocks.listManuscriptRevisions).toHaveBeenCalledOnce();
  });

  it("suspends all hidden knowledge queries and resumes when shown", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><KnowledgeReviewView embedded chapterId="chapter-1" active={false} /></QueryClientProvider>);
    await act(async () => {});
    expect(mocks.listKnowledgeCandidates).not.toHaveBeenCalled();
    expect(mocks.detectCandidateConflicts).not.toHaveBeenCalled();
    expect(mocks.listEvidenceAnchors).not.toHaveBeenCalled();
    view.rerender(<QueryClientProvider client={client}><KnowledgeReviewView embedded chapterId="chapter-1" /></QueryClientProvider>);
    await screen.findByText("沈砚 · 进入 · 雾城");
    expect(mocks.listKnowledgeCandidates).toHaveBeenCalledOnce();
  });

  it("reports an in-flight approval and prevents switching its chapter until completion", async () => {
    let finish!: () => void;
    mocks.reviewKnowledgeCandidate.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const pending = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KnowledgeReviewView onPendingChange={pending} />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    expect(screen.getByLabelText("章节")).toBeDisabled();
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(true));
    await act(async () => finish());
    await waitFor(() => expect(screen.getByLabelText("章节")).toBeEnabled());
    expect(pending).toHaveBeenLastCalledWith(false);
  });
});
