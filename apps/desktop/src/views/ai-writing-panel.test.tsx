import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type { AiProposal, AiProposalReview, AiRun, ModelProfile, ReviewTrace } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";

const mocks = vi.hoisted(() => ({
  cancelAiTask: vi.fn(),
  decideAiProposal: vi.fn(),
  enqueuePlanningAiJob: vi.fn(),
  generateAiProposal: vi.fn(),
  getConsistencyReviewTrace: vi.fn(),
  getAiBudgetSettings: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  getAiUsageSummary: vi.fn(),
  getWritingReviewPolicy: vi.fn(),
  listen: vi.fn(),
  listAiRuns: vi.fn(),
  listAiProposals: vi.fn(),
  listEntities: vi.fn(),
  listJobs: vi.fn(),
  listModelProfiles: vi.fn(),
  listPlanningSections: vi.fn(),
  rateAiProposal: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    cancelAiTask: mocks.cancelAiTask,
    decideAiProposal: mocks.decideAiProposal,
    enqueuePlanningAiJob: mocks.enqueuePlanningAiJob,
    generateAiProposal: mocks.generateAiProposal,
    getConsistencyReviewTrace: mocks.getConsistencyReviewTrace,
    getAiBudgetSettings: mocks.getAiBudgetSettings,
    getAiTaskPreferences: mocks.getAiTaskPreferences,
    getAiUsageSummary: mocks.getAiUsageSummary,
    getWritingReviewPolicy: mocks.getWritingReviewPolicy,
    listAiRuns: mocks.listAiRuns,
    listAiProposals: mocks.listAiProposals,
    listEntities: mocks.listEntities,
    listJobs: mocks.listJobs,
    listModelProfiles: mocks.listModelProfiles,
    listPlanningSections: mocks.listPlanningSections,
    rateAiProposal: mocks.rateAiProposal,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const profile: ModelProfile = {
  id: "review-profile",
  name: "审核模型",
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
  secretRef: "model-profile:review-profile",
  hasSecret: true,
  createdAt: "0",
  updatedAt: "0",
};

const reviewProposal: AiProposal = {
  id: "proposal-review",
  taskId: "task-review",
  chapterId: "chapter-1",
  action: "CONSISTENCY_CHECK",
  reviewPurpose: "ADMISSION",
  targetRevisionId: null,
  contextVersion: "context-1",
  promptVersion: "r3-writing-v6",
  outputText: "审核结论：阻断\n[阻断] 角色姓名未确定｜主角卡尚未建立｜先建立主角卡并确认姓名。",
  acceptedText: null,
  status: "PENDING",
  createdAt: "0",
  decidedAt: null,
};

const review: AiProposalReview = {
  proposal: reviewProposal,
  validation: {
    status: "VALID",
    messages: [],
    characterCount: 36,
    paragraphCount: 2,
    estimatedOutputTokens: 9,
  },
  feedback: null,
  hasReviewTrace: false,
  consistencyFreshness: "FRESH",
  consistency: {
    verdict: "BLOCKED",
    summary: "主角身份不足，当前不能安全生成正文。",
    findings: [
      {
        severity: "BLOCKER",
        problem: "角色姓名未确定",
        evidence: "主角卡尚未建立",
        suggestion: "先建立主角卡并确认姓名。",
      },
    ],
    parseWarnings: [],
  },
};

describe("AiWritingPanel consistency review", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue(() => {});
    mocks.getAiTaskPreferences.mockResolvedValue(structuredClone(emptyAiTaskPreferences));
    mocks.getAiBudgetSettings.mockResolvedValue({
      currency: "USD",
      dailyLimitMicros: null,
      projectLimitMicros: null,
    });
    mocks.getAiUsageSummary.mockResolvedValue({
      days: 30,
      total: [],
      daily: [],
      byTask: [],
    });
    mocks.getWritingReviewPolicy.mockResolvedValue("BALANCED");
    mocks.listAiRuns.mockResolvedValue([]);
    mocks.listAiProposals.mockResolvedValueOnce([]).mockResolvedValue([review]);
    mocks.listEntities.mockResolvedValue([]);
    mocks.listJobs.mockResolvedValue([]);
    mocks.listModelProfiles.mockResolvedValue([profile]);
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.generateAiProposal.mockResolvedValue(reviewProposal);
    mocks.getConsistencyReviewTrace.mockResolvedValue({
      runId: "task-review",
      reviewPurpose: "ADMISSION",
      chapterId: "chapter-1",
      targetRevisionId: null,
      contextVersion: "context-1",
      claims: [],
      evidence: [],
      deterministicFindings: [],
      modelFindings: [],
      omittedItems: [],
      stageRequests: [],
    } satisfies ReviewTrace);
  });

  it("runs a read-only review with the dedicated task settings", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiWritingPanel
          mode="review"
          chapterId="chapter-1"
          chapterTitle="第1章·入城"
          chapterPlan="主角进入城市并寻找失踪的师父。"
          volumeId="volume-1"
          volumePlan="第一卷规划"
          draft=""
          editor={null}
        />
      </QueryClientProvider>,
    );

    const reviewButton = screen.getByRole("button", { name: "检查创作条件" });
    await waitFor(() => expect(reviewButton).toBeEnabled());
    await waitFor(() =>
      expect(mocks.listAiProposals).toHaveBeenCalledWith(
        expect.objectContaining({ reviewPurpose: "ADMISSION" }),
      ),
    );
    fireEvent.click(reviewButton);

    await waitFor(() =>
      expect(mocks.generateAiProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "CONSISTENCY_CHECK",
          reviewPurpose: "ADMISSION",
          profileId: profile.id,
          temperature: 0.2,
          maxOutputTokens: 8192,
          chapterPlan: "主角进入城市并寻找失踪的师父。",
        }),
      ),
    );

    expect(await screen.findByText("主角身份不足，当前不能安全生成正文。")).toBeVisible();
    expect(screen.getByText(/^审核阻断 ·/)).toBeVisible();
    expect(screen.getByText("角色姓名未确定")).toBeVisible();
    expect(screen.getByText("依据：主角卡尚未建立")).toBeVisible();
    expect(screen.getByText("建议：先建立主角卡并确认姓名。")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看设定与执行卡" })).toHaveAttribute(
      "href",
      "/chapters#chapter-1",
    );
    expect(screen.getByRole("button", { name: "关闭审核" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "生成整章初稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /应用到正文/ })).not.toBeInTheDocument();
  });

  it("restores a persisted running review after the panel remounts", async () => {
    const runningRun: AiRun = {
      id: "task-review",
      taskKey: "consistencyReview",
      source: "WRITING",
      action: "CONSISTENCY_CHECK",
      status: "RUNNING",
      chapterId: "chapter-1",
      reviewPurpose: "ADMISSION",
      chapterTitle: "第1章·入城",
      profileName: "审核模型",
      attemptCount: 1,
      retryReason: null,
      errorCode: null,
      estimatedInputTokens: 1200,
      estimatedOutputTokens: 0,
      estimatedCostMicros: null,
      priceCurrency: "USD",
      promptVersion: "r3-writing-v6",
      createdAt: "0",
      finishedAt: null,
    };
    mocks.listAiRuns.mockReset();
    mocks.listAiRuns.mockResolvedValueOnce([]).mockResolvedValue([runningRun]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000 } },
    });
    const panel = (
      <QueryClientProvider client={queryClient}>
        <AiWritingPanel
          mode="review"
          chapterId="chapter-1"
          chapterTitle="第1章·入城"
          chapterPlan="主角进入城市并寻找失踪的师父。"
          volumeId="volume-1"
          volumePlan="第一卷规划"
          draft=""
          editor={null}
        />
      </QueryClientProvider>
    );

    const firstRender = render(panel);
    await waitFor(() => expect(screen.getByRole("button", { name: "检查创作条件" })).toBeEnabled());
    await waitFor(() => expect(mocks.listAiRuns).toHaveBeenCalledTimes(1));
    firstRender.unmount();

    render(panel);
    const reviewButton = screen.getByRole("button", { name: "检查创作条件" });
    expect(await screen.findByText("模型正在生成结果…")).toBeVisible();
    await waitFor(() => expect(reviewButton).toBeDisabled());
    expect(mocks.listAiRuns).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(mocks.cancelAiTask).toHaveBeenCalledWith("task-review"));
  });

  it("shows declaration evidence when a review trace is available", async () => {
    const claimId = "claim-1";
    const evidenceId = "evidence-1";
    const trace: ReviewTrace = {
      runId: "task-review",
      reviewPurpose: "ADMISSION",
      chapterId: "chapter-1",
      targetRevisionId: null,
      contextVersion: "context-1",
      claims: [
        {
          id: claimId,
          claimType: "REQUIRED_EVENT",
          subject: "主角",
          predicate: "必须经历",
          object: "守门冲突",
          quote: "主角必须经历守门冲突。",
          blockId: "chapter-plan",
          startOffset: 0,
          endOffset: 12,
          importance: 5,
          confidence: 95,
        },
      ],
      evidence: [
        {
          id: evidenceId,
          claimId,
          sourceKind: "LOCKED_RULE",
          sourceRecordId: "00000000-0000-0000-0000-000000000000",
          authority: "LOCKED_RULE",
          excerpt: "本章必须安排守门冲突。",
          sourceRevision: "author-confirmed-rule",
          relevance: 9000,
        },
      ],
      deterministicFindings: [],
      modelFindings: [
        {
          id: "finding-1",
          claimId,
          status: "PASS",
          severity: "INFO",
          sourceKind: "LLM",
          ruleId: null,
          ruleVersion: null,
          ruleScope: null,
          ruleEffectiveAt: null,
          priority: 5,
          problem: "事件满足合同要求。",
          evidenceIds: [evidenceId],
          suggestion: "",
          confidence: 90,
        },
      ],
      omittedItems: [],
      stageRequests: [],
    };
    mocks.listAiProposals.mockReset();
    mocks.listAiProposals.mockResolvedValue([{ ...review, hasReviewTrace: true }]);
    mocks.getConsistencyReviewTrace.mockResolvedValue(trace);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiWritingPanel
          mode="review"
          chapterId="chapter-1"
          chapterTitle="第1章·入城"
          chapterPlan="主角必须经历守门冲突。"
          volumeId="volume-1"
          volumePlan="第一卷规划"
          draft=""
          editor={null}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByText("查看声明与依据"));
    expect(await screen.findByText("REQUIRED_EVENT")).toBeVisible();
    expect(screen.getByText("本章必须安排守门冲突。")).toBeVisible();
    expect(screen.getByText(/LOCKED_RULE · LOCKED_RULE/)).toBeVisible();
  });

  it("marks an outdated review as stale without blocking writing", async () => {
    mocks.listAiProposals.mockReset();
    mocks.listAiProposals.mockResolvedValue([{ ...review, consistencyFreshness: "STALE" }]);
    mocks.listPlanningSections.mockResolvedValue([
      { id: "seed-premise", content: "主角进入城市寻找失踪的师父。" },
      { id: "engine-protagonist", content: "主角要找到师父并查明失踪原因。" },
      { id: "frame-setting", content: "城市中的灵力会在夜间衰减。" },
      { id: "frame-narrative", content: "全书固定使用第三人称。" },
    ]);
    mocks.listEntities.mockResolvedValue([{ entityType: "CHARACTER" }]);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiWritingPanel
          mode="review"
          chapterId="chapter-1"
          chapterTitle="第1章·入城"
          chapterPlan="主角进入城市并寻找失踪的师父。"
          volumeId="volume-1"
          volumePlan="第一卷规划"
          draft=""
          editor={null}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("审核依据已经变化")).toBeVisible();
    expect(screen.getByText(/审核已过期 · 原判断：审核阻断/)).toBeVisible();
    expect(screen.getByText(/这份报告已过期，不再阻止正文生成/)).toBeVisible();
    expect(screen.getByRole("button", { name: "按当前内容重新审核" })).toBeEnabled();
    expect(screen.queryByText(/整章创作与续写已暂停/)).not.toBeInTheDocument();
  });

  it("shows an actionable message when manuscript review fails", async () => {
    mocks.generateAiProposal.mockRejectedValueOnce({
      code: "AI_OUTPUT_LENGTH_LIMIT",
      message: "输出预算不足：模型达到最大输出长度，返回内容未写完；模型没有返回任何可用正文（finish_reason: length）。",
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiWritingPanel
          mode="review"
          reviewPurpose="manuscript"
          chapterId="chapter-1"
          chapterTitle="第1章·入城"
          chapterPlan="主角进入城市并寻找失踪的师父。"
          volumeId="volume-1"
          volumePlan="第一卷规划"
          draft="主角抵达城门。"
          editor={null}
        />
      </QueryClientProvider>,
    );

    const reviewButton = screen.getByRole("button", { name: "审核当前正文" });
    await waitFor(() => expect(reviewButton).toBeEnabled());
    await waitFor(() =>
      expect(mocks.listAiProposals).toHaveBeenCalledWith(
        expect.objectContaining({ reviewPurpose: "MANUSCRIPT" }),
      ),
    );
    fireEvent.click(reviewButton);
    await waitFor(() =>
      expect(mocks.generateAiProposal).toHaveBeenCalledWith(
        expect.objectContaining({ reviewPurpose: "MANUSCRIPT" }),
      ),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("输出预算不足");
    expect(alert).toHaveTextContent("模型没有返回任何可用正文");
    expect(alert).toHaveTextContent("请在“AI 任务模型”中提高该任务的最大输出后重试");
    expect(alert.textContent).not.toContain("输出预算不足：输出预算不足");
  });

  it("requires a fresh review when the project uses strict admission", async () => {
    const openAdmissionReview = vi.fn();
    mocks.getWritingReviewPolicy.mockResolvedValue("REQUIRED");
    mocks.listAiProposals.mockReset();
    mocks.listAiProposals.mockResolvedValue([]);
    mocks.listPlanningSections.mockResolvedValue([
      { id: "seed-premise", content: "主角进入城市寻找失踪的师父。" },
      { id: "engine-protagonist", content: "主角要找到师父并查明失踪原因。" },
      { id: "frame-setting", content: "城市中的灵力会在夜间衰减。" },
      { id: "frame-narrative", content: "全书固定使用第三人称。" },
    ]);
    mocks.listEntities.mockResolvedValue([{ entityType: "CHARACTER" }]);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiWritingPanel
          mode="create"
          chapterId="chapter-1"
          chapterTitle="第1章·入城"
          chapterPlan="主角进入城市并寻找失踪的师父。"
          volumeId="volume-1"
          volumePlan="第一卷规划"
          draft="主角抵达城门。"
          editor={null}
          onOpenAdmissionReview={openAdmissionReview}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/严格准入/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "前往创作准入处理" }));
    expect(openAdmissionReview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "生成新版整章" })).toBeDisabled());
    expect(screen.queryByRole("button", { name: "生成续写候选" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重写选区" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "润色选区" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "章节摘要" })).not.toBeInTheDocument();
    expect(screen.queryByText("按段选择")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "仅采用已选段落" })).not.toBeInTheDocument();
  });
});
