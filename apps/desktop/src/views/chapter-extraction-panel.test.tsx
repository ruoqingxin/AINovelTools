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
  decideExtractionItem: vi.fn(),
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
    mocks.decideExtractionItem.mockResolvedValue({ ...item, status: "REJECTED" });
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

  it.each(["{", "[]", "null", '""'])("does not adopt invalid candidate JSON: %s", async (value) => {
    const factItem = { ...item, kind: "FACT", payload: { subject: "沈砚", predicate: "进入", object: "雾城" } };
    mocks.listChapterExtractions.mockResolvedValue([{ ...proposal, items: [factItem] }]);
    renderPanel();
    fireEvent.change(await screen.findByLabelText("沈砚 · 进入 · 雾城 payload"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "采用" }));
    await screen.findByRole("alert");
    expect(mocks.updateExtractionItem).not.toHaveBeenCalled();
    expect(mocks.adoptExtractionItem).not.toHaveBeenCalled();
    expect(screen.getByLabelText("沈砚 · 进入 · 雾城 payload")).toHaveValue(value);
  });

  it.each(['{"relationType":"保存中的新修改"}', JSON.stringify(item.payload, null, 2)])("keeps newer typing or a reversion during save: %s", async (newValue) => {
    let finish!: (saved: ChapterExtractionItem) => void;
    mocks.updateExtractionItem.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChapterExtractionPanel chapterId="chapter-1" onPendingChange={pending} />
    </QueryClientProvider>);
    const input = await screen.findByLabelText("沈砚 · 盟友 · 顾临 payload");
    fireEvent.change(input, { target: { value: '{"relationType":"已提交"}' } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(mocks.updateExtractionItem).toHaveBeenCalledOnce());
    fireEvent.change(input, { target: { value: newValue } });
    mocks.listChapterExtractions.mockResolvedValue([{ ...proposal, items: [{ ...item, payload: { relationType: "已提交" } }] }]);
    await act(async () => finish({ ...item, payload: { relationType: "已提交" } }));
    await screen.findByText("候选修改已保存。");
    expect(screen.getByRole("textbox", { name: /payload/ })).toHaveValue(newValue);
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("候选修改未保存")).toBeVisible();
  });

  it("requires confirmation before rejection and saves edits before deferring", async () => {
    renderPanel();
    fireEvent.change(await screen.findByLabelText("沈砚 · 盟友 · 顾临 payload"), { target: { value: '{"relationType":"合作"}' } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
      expect(mocks.decideExtractionItem).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "延期" }));
      await waitFor(() => expect(mocks.decideExtractionItem).toHaveBeenCalledWith({
        id: item.id, expectedStatus: item.status, decision: "DEFERRED",
      }));
      expect(mocks.updateExtractionItem).toHaveBeenCalledWith(expect.objectContaining({ payload: { relationType: "合作" } }));
      expect(mocks.updateExtractionItem.mock.invocationCallOrder[0]).toBeLessThan(mocks.decideExtractionItem.mock.invocationCallOrder[0]!);
    } finally { confirm.mockRestore(); }
  });

  it("retains edits through a server refetch and refuses to overwrite a known changed payload", async () => {
    renderPanel();
    fireEvent.change(await screen.findByLabelText("沈砚 · 盟友 · 顾临 payload"), { target: { value: '{"relationType":"本地"}' } });
    mocks.listChapterExtractions.mockResolvedValue([{ ...proposal, items: [{ ...item, payload: { relationType: "外部更新" } }] }]);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByLabelText("未命名候选 payload");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("候选已有新内容");
    expect(mocks.updateExtractionItem).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: /payload/ })).toHaveValue('{"relationType":"本地"}');
  });

  it("does not load hidden candidates, then resumes queries when shown", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><ChapterExtractionPanel chapterId="chapter-1" active={false} /></QueryClientProvider>);
    await act(async () => {});
    expect(mocks.listChapterExtractions).not.toHaveBeenCalled();
    expect(mocks.currentManuscript).not.toHaveBeenCalled();
    expect(mocks.listCurrentFacts).not.toHaveBeenCalled();
    expect(mocks.listModelProfiles).not.toHaveBeenCalled();
    view.rerender(<QueryClientProvider client={client}><ChapterExtractionPanel chapterId="chapter-1" /></QueryClientProvider>);
    await screen.findByLabelText("沈砚 · 盟友 · 顾临 payload");
    expect(mocks.listChapterExtractions).toHaveBeenCalledOnce();
  });

  it("keeps the saved payload visible if the subsequent adoption fails", async () => {
    const factItem = { ...item, kind: "FACT", payload: { subject: "沈砚", predicate: "进入", object: "雾城" } };
    mocks.listChapterExtractions.mockResolvedValue([{ ...proposal, items: [factItem] }]);
    mocks.updateExtractionItem.mockImplementation(async (input) => {
      const saved = { ...factItem, payload: input.payload };
      mocks.listChapterExtractions.mockResolvedValue([{ ...proposal, items: [saved] }]);
      return saved;
    });
    mocks.adoptExtractionItem.mockRejectedValueOnce(new Error("采用失败"));
    renderPanel();
    fireEvent.change(await screen.findByLabelText("沈砚 · 进入 · 雾城 payload"), {
      target: { value: '{"subject":"沈砚","predicate":"进入","object":"内城"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "采用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("采用失败");
    expect(JSON.parse((screen.getByRole("textbox", { name: /payload/ }) as HTMLTextAreaElement).value).object).toBe("内城");
  });
});
