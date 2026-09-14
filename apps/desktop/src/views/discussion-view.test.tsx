import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type {
  DiscussionCandidate,
  DiscussionExchange,
  DiscussionMessage,
  DiscussionSession,
  ModelProfile,
} from "../lib/tauri-client";
import { DiscussionView } from "./discussion-view";

const mocks = vi.hoisted(() => ({
  askProjectDiscussion: vi.fn(),
  createDiscussionCandidate: vi.fn(),
  createDiscussionSession: vi.fn(),
  dismissDiscussionCandidate: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  listDiscussionCandidates: vi.fn(),
  listDiscussionMessages: vi.fn(),
  listDiscussionSessions: vi.fn(),
  listEvidenceAnchors: vi.fn(),
  listModelProfiles: vi.fn(),
  listPlanNodes: vi.fn(),
  listPlanningSections: vi.fn(),
  promoteDiscussionCandidate: vi.fn(),
  promoteDiscussionCandidateToForeshadowingReview: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    askProjectDiscussion: mocks.askProjectDiscussion,
    createDiscussionCandidate: mocks.createDiscussionCandidate,
    createDiscussionSession: mocks.createDiscussionSession,
    dismissDiscussionCandidate: mocks.dismissDiscussionCandidate,
    getAiTaskPreferences: mocks.getAiTaskPreferences,
    listDiscussionCandidates: mocks.listDiscussionCandidates,
    listDiscussionMessages: mocks.listDiscussionMessages,
    listDiscussionSessions: mocks.listDiscussionSessions,
    listEvidenceAnchors: mocks.listEvidenceAnchors,
    listModelProfiles: mocks.listModelProfiles,
    listPlanNodes: mocks.listPlanNodes,
    listPlanningSections: mocks.listPlanningSections,
    promoteDiscussionCandidate: mocks.promoteDiscussionCandidate,
    promoteDiscussionCandidateToForeshadowingReview:
      mocks.promoteDiscussionCandidateToForeshadowingReview,
  };
});

const profile: ModelProfile = {
  id: "discussion-profile",
  name: "讨论模型",
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
  secretRef: "model-profile:discussion-profile",
  hasSecret: true,
  createdAt: "0",
  updatedAt: "0",
};

const session: DiscussionSession = {
  id: "session-1",
  projectId: "project-1",
  title: "作品共创讨论",
  scopeKind: "PROJECT",
  scopeId: null,
  scopeText: null,
  summary: "",
  createdAt: "0",
  updatedAt: "0",
};

const userMessage: DiscussionMessage = {
  id: "message-user",
  sessionId: session.id,
  role: "USER",
  content: "如果主角在第二卷末提前知道真相，会影响哪些伏笔？",
  profileId: null,
  contextVersion: null,
  contextSummary: "全书讨论",
  createdAt: "0",
};

const assistantMessage: DiscussionMessage = {
  id: "message-assistant",
  sessionId: session.id,
  role: "ASSISTANT",
  content: "可以把真相提前到第二卷末，同时保留一页未解释的证据来维持悬念。",
  profileId: profile.id,
  contextVersion: "context-1",
  contextSummary: "全书讨论",
  createdAt: "0",
};

const exchange: DiscussionExchange = { userMessage, assistantMessage };

function renderView() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DiscussionView />
    </QueryClientProvider>,
  );
}

describe("DiscussionView", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    const preferences = structuredClone(emptyAiTaskPreferences);
    preferences.workDesign.profileId = profile.id;
    mocks.askProjectDiscussion.mockResolvedValue(exchange);
    mocks.createDiscussionCandidate.mockImplementation(async (input) => ({
      id: "candidate-created",
      sessionId: input.sessionId,
      messageId: input.messageId,
      kind: input.kind,
      content: input.content,
      targetSectionId: input.targetSectionId ?? null,
      status: "PENDING",
      promotedObjectId: null,
      createdAt: "0",
      updatedAt: "0",
    }));
    mocks.createDiscussionSession.mockResolvedValue({
      ...session,
      id: "session-created",
      title: "第二卷剧情讨论",
    });
    mocks.dismissDiscussionCandidate.mockImplementation(async ({ id }) => ({
      id,
      sessionId: session.id,
      messageId: assistantMessage.id,
      kind: "FORESHADOWING",
      content: "第二封信可能是误导。",
      targetSectionId: null,
      status: "DISMISSED",
      promotedObjectId: null,
      createdAt: "0",
      updatedAt: "0",
    }));
    mocks.getAiTaskPreferences.mockResolvedValue(preferences);
    mocks.listDiscussionCandidates.mockResolvedValue([]);
    mocks.listDiscussionMessages.mockResolvedValue([]);
    mocks.listDiscussionSessions.mockResolvedValue([session]);
    mocks.listEvidenceAnchors.mockResolvedValue([
      {
        id: "anchor-1",
        sourceVersion: "manuscript:revision-1",
        blockId: "paragraph-1",
      },
    ]);
    mocks.listModelProfiles.mockResolvedValue([profile]);
    mocks.listPlanNodes.mockResolvedValue([]);
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.promoteDiscussionCandidate.mockImplementation(async ({ id }) => ({
      id,
      sessionId: session.id,
      messageId: assistantMessage.id,
      kind: "PLANNING",
      content: "第二卷末揭露真相，同时保留证据。",
      targetSectionId: "engine-theme",
      status: "PROMOTED",
      promotedObjectId: "engine-theme",
      createdAt: "0",
      updatedAt: "0",
    }));
    mocks.promoteDiscussionCandidateToForeshadowingReview.mockImplementation(async ({ id }) => ({
      id,
      sessionId: session.id,
      messageId: assistantMessage.id,
      kind: "FORESHADOWING",
      content: "第二封信可能是误导。",
      targetSectionId: null,
      status: "PROMOTED",
      promotedObjectId: "extraction-item-1",
      createdAt: "0",
      updatedAt: "0",
    }));
  });

  it("creates a scoped discussion session from the sidebar", async () => {
    renderView();

    const title = await screen.findByDisplayValue("作品共创讨论");
    fireEvent.change(title, { target: { value: "第二卷剧情讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "建立会话" }));

    await waitFor(() =>
      expect(mocks.createDiscussionSession).toHaveBeenCalledWith({
        title: "第二卷剧情讨论",
        scopeKind: "PROJECT",
        scopeId: null,
        scopeText: null,
      }),
    );
  });

  it("creates a discussion session for the selected manuscript text", async () => {
    mocks.listPlanNodes.mockResolvedValue([
      {
        id: "chapter-1",
        parentId: null,
        kind: "CHAPTER",
        title: "第1章·入城",
        sortOrder: 0,
        archived: false,
        revision: 1,
      },
    ]);
    renderView();

    const scopeSelect = await screen.findByLabelText("范围");
    fireEvent.change(scopeSelect, { target: { value: "SELECTION" } });
    fireEvent.change(await screen.findByLabelText("章节"), {
      target: { value: "chapter-1" },
    });
    fireEvent.change(screen.getByPlaceholderText("粘贴当前选中的正文片段…"), {
      target: { value: "城门在午夜后没有影子。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "建立会话" }));

    await waitFor(() =>
      expect(mocks.createDiscussionSession).toHaveBeenCalledWith({
        title: "作品共创讨论",
        scopeKind: "SELECTION",
        scopeId: "chapter-1",
        scopeText: "城门在午夜后没有影子。",
      }),
    );
  });

  it("sends a discussion message and explicitly saves the reply as a planning candidate", async () => {
    mocks.listDiscussionMessages.mockResolvedValue([userMessage, assistantMessage]);
    renderView();

    const composer = await screen.findByPlaceholderText(/如果主角在第二卷提前知道真相/);
    fireEvent.change(composer, { target: { value: userMessage.content } });
    fireEvent.click(screen.getByRole("button", { name: "发送讨论" }));

    await waitFor(() =>
      expect(mocks.askProjectDiscussion).toHaveBeenCalledWith({
        sessionId: session.id,
        profileId: profile.id,
        message: userMessage.content,
        temperature: 0.45,
        maxOutputTokens: 4096,
      }),
    );

    const reply = (await screen.findByText(assistantMessage.content, {
      selector: ".discussion-message-content",
    })).closest("article");
    expect(reply).not.toBeNull();
    fireEvent.change(within(reply!).getByLabelText("保存类型"), {
      target: { value: "PLANNING" },
    });
    fireEvent.change(within(reply!).getByLabelText("目标规划项"), {
      target: { value: "engine-theme" },
    });
    fireEvent.click(within(reply!).getByRole("button", { name: "保存候选" }));

    await waitFor(() =>
      expect(mocks.createDiscussionCandidate).toHaveBeenCalledWith({
        sessionId: session.id,
        messageId: assistantMessage.id,
        kind: "PLANNING",
        content: assistantMessage.content,
        targetSectionId: "engine-theme",
      }),
    );
  });

  it("promotes a planning candidate and sends foreshadowing to extraction review", async () => {
    const planningCandidate: DiscussionCandidate = {
      id: "candidate-planning",
      sessionId: session.id,
      messageId: assistantMessage.id,
      kind: "PLANNING",
      content: "第二卷末揭露真相，同时保留证据。",
      targetSectionId: "engine-theme",
      status: "PENDING",
      promotedObjectId: null,
      createdAt: "0",
      updatedAt: "0",
    };
    const foreshadowingCandidate: DiscussionCandidate = {
      ...planningCandidate,
      id: "candidate-foreshadowing",
      kind: "FORESHADOWING",
      content: "第二封信可能是误导。",
      targetSectionId: null,
    };
    mocks.listDiscussionCandidates.mockResolvedValue([
      planningCandidate,
      foreshadowingCandidate,
    ]);
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "写入规划待定区" }));
    await waitFor(() =>
      expect(mocks.promoteDiscussionCandidate).toHaveBeenCalledWith({
        id: planningCandidate.id,
        expectedStatus: "PENDING",
      }),
    );

    const foreshadowing = screen
      .getByText(foreshadowingCandidate.content)
      .closest("article");
    expect(foreshadowing).not.toBeNull();
    fireEvent.change(
      within(foreshadowing!).getByLabelText(
        `选择${foreshadowingCandidate.content}的正文证据`,
      ),
      { target: { value: "anchor-1" } },
    );
    fireEvent.click(within(foreshadowing!).getByRole("button", { name: "送入正文审核" }));
    await waitFor(() =>
      expect(mocks.promoteDiscussionCandidateToForeshadowingReview).toHaveBeenCalledWith({
        id: foreshadowingCandidate.id,
        expectedStatus: "PENDING",
        evidenceAnchorId: "anchor-1",
      }),
    );
  });
});
