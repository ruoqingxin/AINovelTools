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
  DiscussionWorkspace,
  DiscussionDesignProposal,
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
  getDiscussionWorkspace: vi.fn(),
  saveDiscussionWorkspace: vi.fn(),
  listDiscussionDesignProposals: vi.fn(),
  listDiscussionDraftRevisions: vi.fn(),
  summarizeDiscussionDesign: vi.fn(),
  confirmDiscussionDesign: vi.fn(),
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
    getDiscussionWorkspace: mocks.getDiscussionWorkspace,
    saveDiscussionWorkspace: mocks.saveDiscussionWorkspace,
    listDiscussionDesignProposals: mocks.listDiscussionDesignProposals,
    listDiscussionDraftRevisions: mocks.listDiscussionDraftRevisions,
    summarizeDiscussionDesign: mocks.summarizeDiscussionDesign,
    confirmDiscussionDesign: mocks.confirmDiscussionDesign,
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
    localStorage.clear();
    window.history.replaceState(null, "", "/discussion");
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
    mocks.getDiscussionWorkspace.mockImplementation(async (sessionId): Promise<DiscussionWorkspace> => ({
      sessionId, topicKind: "FREE", linkedEntityId: null,
      draft: { chosen: "", alternatives: "", questions: "" }, version: 0,
    }));
    mocks.saveDiscussionWorkspace.mockImplementation(async (workspace) => ({
      ...workspace, version: workspace.version + 1,
    }));
    mocks.listDiscussionDesignProposals.mockResolvedValue([]);
    mocks.listDiscussionDraftRevisions.mockResolvedValue([]);
    mocks.confirmDiscussionDesign.mockResolvedValue(["entity-new"]);
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

    fireEvent.click(screen.getByRole("button", { name: "新建讨论" }));
    const title = await screen.findByDisplayValue("作品共创讨论");
    fireEvent.change(title, { target: { value: "第二卷剧情讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "建立会话" }));

    await waitFor(() =>
      expect(mocks.createDiscussionSession).toHaveBeenCalledWith({
        title: "第二卷剧情讨论",
        scopeKind: "PROJECT",
        scopeId: null,
        scopeText: null,
        topicKind: "FREE",
      }),
    );
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#session-created");
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

    fireEvent.click(screen.getByRole("button", { name: "新建讨论" }));
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
        topicKind: "FREE",
      }),
    );
  });

  it("sends a discussion message and explicitly saves the reply as a planning candidate", async () => {
    mocks.listDiscussionMessages.mockResolvedValue([userMessage, assistantMessage]);
    renderView();

    const composer = await screen.findByLabelText("讨论内容");
    await waitFor(() => expect(composer).toBeEnabled());
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
    fireEvent.click(within(reply!).getByText("保存片段为候选"));
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

    fireEvent.click(await screen.findByText(/候选内容/));
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
    fireEvent.click(within(foreshadowing!).getByRole("button", { name: "送入事实审核" }));
    await waitFor(() =>
      expect(mocks.promoteDiscussionCandidateToForeshadowingReview).toHaveBeenCalledWith({
        id: foreshadowingCandidate.id,
        expectedStatus: "PENDING",
        evidenceAnchorId: "anchor-1",
      }),
    );
  });

  it("creates an item discussion without requiring a name or chapter", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "新建讨论" }));
    fireEvent.change(await screen.findByLabelText("构思类型"), { target: { value: "ITEM" } });
    fireEvent.click(screen.getByRole("button", { name: "建立会话" }));
    await waitFor(() => expect(mocks.createDiscussionSession).toHaveBeenCalledWith(
      expect.objectContaining({ topicKind: "ITEM", scopeKind: "PROJECT", scopeId: null }),
    ));
  });

  it("autosaves selected ideas and preserves over-limit drafts without truncation", async () => {
    renderView();
    const chosen = await screen.findByLabelText("已选定内容");
    fireEvent.change(chosen, { target: { value: "灯只能储存三句话。" } });
    await waitFor(() => expect(mocks.saveDiscussionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ draft: expect.objectContaining({ chosen: "灯只能储存三句话。" }) }),
    ), { timeout: 3000 });
    await screen.findByText(/草稿已保存/);
    const oversized = "甲".repeat(50001);
    fireEvent.change(chosen, { target: { value: oversized } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("合计最多 50000 字");
    expect(chosen).toHaveValue(oversized);
    expect(screen.getByRole("button", { name: "整理为实体与设定" })).toBeDisabled();
  });

  it("keeps unsent input locally and refuses messages above the limit", async () => {
    renderView();
    const composer = await screen.findByLabelText("讨论内容");
    await waitFor(() => expect(composer).toBeEnabled());
    const content = "字".repeat(20001);
    fireEvent.change(composer, { target: { value: content } });
    expect(screen.getByRole("button", { name: "发送讨论" })).toBeDisabled();
    expect(localStorage.getItem(`discussion-composer:${session.id}`)).toBe(content);
    expect(mocks.askProjectDiscussion).not.toHaveBeenCalled();
  });

  it("loads older messages with a stable cursor without deleting the latest page", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      ...userMessage, id: `message-${index}`, content: `讨论 ${index}`,
    }));
    mocks.listDiscussionMessages.mockImplementation(async (_sessionId, _limit, beforeId) =>
      beforeId ? [{ ...userMessage, id: "earliest", content: "最早的灵感" }] : messages);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "更早讨论" }));
    expect(await screen.findByText("最早的灵感")).toBeInTheDocument();
    expect(screen.getByText("讨论 99")).toBeInTheDocument();
    expect(mocks.listDiscussionMessages).toHaveBeenCalledWith(session.id, 100, "message-0");
  });

  it("records an AI suggestion as an alternative without confirming it", async () => {
    mocks.listDiscussionMessages.mockResolvedValue([userMessage, assistantMessage]);
    renderView();
    const button = await screen.findByRole("button", { name: "记入备选方向" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(mocks.saveDiscussionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ draft: { chosen: "", alternatives: assistantMessage.content, questions: "" } }),
    ));
    expect(await screen.findByRole("textbox", { name: "备选方向" })).toHaveValue(assistantMessage.content);
    expect(mocks.confirmDiscussionDesign).not.toHaveBeenCalled();
  });

  it("restores an unsaved local workspace after reopening the same discussion", async () => {
    localStorage.setItem(`discussion-workspace:${session.id}`, JSON.stringify({
      sessionId: session.id, topicKind: "ITEM", linkedEntityId: null, version: 0,
      draft: { chosen: "关闭前未保存的能力规则。", alternatives: "", questions: "" },
    }));
    renderView();
    expect(await screen.findByLabelText("已选定内容")).toHaveValue("关闭前未保存的能力规则。");
    await waitFor(() => expect(mocks.saveDiscussionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ draft: expect.objectContaining({ chosen: "关闭前未保存的能力规则。" }) }),
    ), { timeout: 3000 });
  });

  it("summarizes the saved workspace and confirms edited entities only on author approval", async () => {
    mocks.listDiscussionMessages.mockResolvedValue([userMessage, assistantMessage]);
    const proposal: DiscussionDesignProposal = {
      id: "proposal-1", sessionId: session.id, workspaceVersion: 0,
      entities: [{
        entityType: "ITEM", name: "吞声灯", description: "一盏储存声音的灯。",
        aliases: [], tags: [], attributes: { capacity: 3 }, settings: ["只能储存三句话。"],
        visibility: "AUTHOR_ONLY", targetEntityId: null, expectedEntityVersion: null,
      }],
      sourceMessageIds: [userMessage.id, assistantMessage.id], contextVersion: "context-design",
      omittedMessageCount: 50, status: "PENDING", promotedEntityIds: [], createdAt: "",
    };
    mocks.summarizeDiscussionDesign.mockImplementation(async () => {
      mocks.listDiscussionDesignProposals.mockResolvedValue([proposal]);
      return proposal;
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "整理为实体与设定" }));
    await waitFor(() => expect(mocks.summarizeDiscussionDesign).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id, expectedWorkspaceVersion: 0 }),
    ));
    expect(await screen.findByText(/未纳入较早的 50 条消息/)).toBeInTheDocument();
    expect(mocks.confirmDiscussionDesign).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "整理结果" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "已选定内容" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "静语灯" } });
    fireEvent.click(screen.getByRole("button", { name: "返回构思草稿" }));
    expect(await screen.findByRole("textbox", { name: "已选定内容" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看整理结果/ }));
    expect(screen.getByLabelText("名称")).toHaveValue("静语灯");
    fireEvent.click(screen.getByRole("button", { name: "确认选中内容入库" }));
    await waitFor(() => expect(mocks.confirmDiscussionDesign).toHaveBeenCalledWith(
      proposal.id, [expect.objectContaining({ name: "静语灯", settings: ["只能储存三句话。"] })],
    ));
  });

  it("starts with a compact session toolbar and requires content before organizing", async () => {
    renderView();
    await screen.findByRole("heading", { name: "这次想构思什么？" });
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "整理为实体与设定" })).toBeDisabled();
    expect(screen.getByText("暂无可整理内容")).toBeInTheDocument();
    expect(screen.getByText("模型与费用").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "新建讨论" }));
    expect(screen.getByLabelText("标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消新建" }));
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
  });

  it("puts starter prompts into the composer without sending or replacing an existing idea", async () => {
    renderView();
    const composer = await screen.findByRole("textbox", { name: "讨论内容" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.click(await screen.findByRole("button", { name: "设计一件物品" }));
    expect((composer as HTMLTextAreaElement).value).toContain("独特能力的物品");
    expect(composer).toHaveFocus();
    expect(mocks.askProjectDiscussion).not.toHaveBeenCalled();
    fireEvent.change(composer, { target: { value: "我的灵感是吞声灯。" } });
    fireEvent.click(screen.getByRole("button", { name: "塑造一个角色" }));
    expect((composer as HTMLTextAreaElement).value).toMatch(/^我的灵感是吞声灯。\n\n/);
    expect(mocks.askProjectDiscussion).not.toHaveBeenCalled();
  });

  it("switches draft fields accessibly while preserving edits", async () => {
    renderView();
    const chosen = await screen.findByRole("textbox", { name: "已选定内容" });
    fireEvent.change(chosen, { target: { value: "最多储存三句话。" } });
    const tablist = screen.getByRole("tablist", { name: "构思内容" });
    fireEvent.click(within(tablist).getByRole("tab", { name: "备选方向" }));
    expect(screen.queryByRole("textbox", { name: "已选定内容" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "备选方向" }), { target: { value: "也许交换一段记忆。" } });
    fireEvent.keyDown(within(tablist).getByRole("tab", { name: /备选方向/ }), { key: "ArrowLeft" });
    expect(screen.getByRole("textbox", { name: "已选定内容" })).toHaveValue("最多储存三句话。");
    expect(within(tablist).getByRole("tab", { name: /已选定/ })).toHaveFocus();
    await waitFor(() => expect(mocks.saveDiscussionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ draft: { chosen: "最多储存三句话。", alternatives: "也许交换一段记忆。", questions: "" } }),
    ), { timeout: 3000 });
  });

  it("sends with Ctrl+Enter but does not bypass message length validation", async () => {
    renderView();
    const composer = await screen.findByRole("textbox", { name: "讨论内容" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "字".repeat(20001) } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(mocks.askProjectDiscussion).not.toHaveBeenCalled();
    fireEvent.change(composer, { target: { value: "灯的代价是什么？" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(mocks.askProjectDiscussion).toHaveBeenCalledWith(
      expect.objectContaining({ message: "灯的代价是什么？" }),
    ));
  });

  it("returns to alternatives each time an idea is recorded, even after another field was selected", async () => {
    mocks.listDiscussionMessages.mockResolvedValue([assistantMessage]);
    renderView();
    const record = await screen.findByRole("button", { name: "记入备选方向" });
    await waitFor(() => expect(record).toBeEnabled());
    fireEvent.click(record);
    expect(await screen.findByRole("textbox", { name: "备选方向" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "未决问题" }));
    await waitFor(() => expect(record).toBeEnabled());
    fireEvent.click(record);
    expect(await screen.findByRole("textbox", { name: "备选方向" })).toBeInTheDocument();
  });
});
