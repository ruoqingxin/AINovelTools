import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type { ChapterExtractionItem, ChapterExtractionProposal, Fact, ModelProfile } from "../lib/tauri-client";
import { ChapterExtractionPanel } from "./chapter-extraction-panel";

const mocks = vi.hoisted(() => ({
  adoptExtractionItem: vi.fn(),
  currentManuscript: vi.fn(),
  extractChapterCandidates: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  listChapterExtractions: vi.fn(),
  listCurrentFacts: vi.fn(),
  listEvidenceAnchors: vi.fn(),
  listModelProfiles: vi.fn(),
  updateExtractionItem: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, ...mocks };
});

vi.mock("./ai-model-note", () => ({ AiModelNote: () => null }));

const profile: ModelProfile = {
  id: "extraction-profile",
  name: "提取模型",
  provider: "DEEP_SEEK",
  capability: "CHAT",
  baseUrl: "https://api.deepseek.com",
  modelId: "deepseek-v4-flash",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  privacyLevel: "ALLOW_CLOUD",
  timeoutSeconds: 120,
  retryLimit: 1,
  inputPriceMicrosPerMillion: 2_500_000,
  outputPriceMicrosPerMillion: 10_000_000,
  priceCurrency: "USD",
  secretRef: "model-profile:extraction-profile",
  hasSecret: true,
  createdAt: "0",
  updatedAt: "0",
};

const facts: Fact[] = [
  {
    knowledgeId: "fact-1",
    projectId: "project-1",
    knowledgeVersion: 1,
    subject: "沈砚",
    predicate: "结盟",
    object: "顾临",
    sourceRevisionId: "revision-1",
    evidenceAnchorIds: ["anchor-1"],
    lifecycleStatus: "ACTIVE",
    createdBy: "tester",
    createdAt: "0",
    updatedAt: "0",
  },
  {
    knowledgeId: "fact-2",
    projectId: "project-1",
    knowledgeVersion: 1,
    subject: "顾临",
    predicate: "进入",
    object: "雾城",
    sourceRevisionId: "revision-1",
    evidenceAnchorIds: ["anchor-1"],
    lifecycleStatus: "ACTIVE",
    createdBy: "tester",
    createdAt: "0",
    updatedAt: "0",
  },
];

const item: ChapterExtractionItem = {
  id: "extraction-1",
  proposalId: "proposal-1",
  kind: "RELATION",
  payload: {
    fromKnowledgeId: "",
    toKnowledgeId: "",
    fromHint: "沈砚",
    toHint: "顾临",
    relationType: "盟友",
  },
  evidenceAnchorId: "anchor-1",
  status: "PENDING_REVIEW",
  finalObjectId: null,
  createdAt: "0",
  updatedAt: "0",
};

const proposal: ChapterExtractionProposal = {
  id: "proposal-1",
  projectId: "project-1",
  chapterId: "chapter-1",
  sourceRevisionId: "revision-1",
  aiRunId: null,
  status: "PENDING_REVIEW",
  items: [item],
  createdAt: "0",
  updatedAt: "0",
};

function renderPanel(onOpenFactReview?: () => void) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChapterExtractionPanel chapterId="chapter-1" onOpenFactReview={onOpenFactReview} />
    </QueryClientProvider>,
  );
}

describe("ChapterExtractionPanel", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    const preferences = structuredClone(emptyAiTaskPreferences);
    preferences.knowledgeExtraction.profileId = profile.id;
    mocks.currentManuscript.mockResolvedValue({ id: "revision-1" });
    mocks.extractChapterCandidates.mockResolvedValue(proposal);
    mocks.getAiTaskPreferences.mockResolvedValue(preferences);
    mocks.listChapterExtractions.mockResolvedValue([proposal]);
    mocks.listCurrentFacts.mockResolvedValue(facts);
    mocks.listEvidenceAnchors.mockResolvedValue([
      { id: "anchor-1", sourceVersion: "manuscript:revision-1", blockId: "block-1" },
    ]);
    mocks.listModelProfiles.mockResolvedValue([profile]);
    mocks.updateExtractionItem.mockImplementation(async (input) => ({ ...item, payload: input.payload }));
    mocks.adoptExtractionItem.mockResolvedValue({
      ...item,
      payload: { ...item.payload, fromKnowledgeId: "fact-1", toKnowledgeId: "fact-2" },
      status: "ACCEPTED",
      finalObjectId: "relation-1",
    });
  });

  it("saves selected fact endpoints before adopting a relation", async () => {
    renderPanel();

    fireEvent.change(await screen.findByLabelText("沈砚 · 盟友 · 顾临起点事实"), {
      target: { value: "fact-1" },
    });
    fireEvent.change(screen.getByLabelText("沈砚 · 盟友 · 顾临终点事实"), {
      target: { value: "fact-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "采用" }));

    await waitFor(() =>
      expect(mocks.updateExtractionItem).toHaveBeenCalledWith({
        id: "extraction-1",
        expectedStatus: "PENDING_REVIEW",
        payload: expect.objectContaining({
          fromKnowledgeId: "fact-1",
          toKnowledgeId: "fact-2",
        }),
      }),
    );
    expect(mocks.adoptExtractionItem).toHaveBeenCalledWith({
      id: "extraction-1",
      expectedStatus: "PENDING_REVIEW",
    });
  });

  it("opens the current chapter fact review after converting a fact candidate", async () => {
    const factItem = {
      ...item, kind: "FACT", payload: { subject: "沈砚", predicate: "进入", object: "雾城" },
    };
    mocks.listChapterExtractions.mockResolvedValue([{ ...proposal, items: [factItem] }]);
    mocks.adoptExtractionItem.mockResolvedValue({ ...factItem, status: "ACCEPTED" });
    const openReview = vi.fn();
    renderPanel(openReview);
    fireEvent.click(await screen.findByRole("button", { name: "采用" }));
    await waitFor(() => expect(openReview).toHaveBeenCalledOnce());
    expect(mocks.adoptExtractionItem).toHaveBeenCalledWith({
      id: item.id, expectedStatus: "PENDING_REVIEW",
    });
  });

  it("extracts from the latest saved revision in the shared manuscript cache", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ChapterExtractionPanel chapterId="chapter-1" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "提取本章候选" })).toBeEnabled());
    act(() => client.setQueryData(["manuscript", "chapter-1"], { id: "revision-2" }));
    await screen.findByText("基于修订 revision");
    fireEvent.click(screen.getByRole("button", { name: "提取本章候选" }));
    await waitFor(() => expect(mocks.extractChapterCandidates).toHaveBeenCalledWith(expect.objectContaining({
      chapterId: "chapter-1", sourceRevisionId: "revision-2",
    })));
  });
});
