import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import type { AiProposal, AiProposalReview, ModelProfile } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";

const mocks = vi.hoisted(() => ({
  cancelAiTask: vi.fn(),
  decideAiProposal: vi.fn(),
  enqueuePlanningAiJob: vi.fn(),
  generateAiProposal: vi.fn(),
  getAiBudgetSettings: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  getAiUsageSummary: vi.fn(),
  getWritingReviewPolicy: vi.fn(),
  listen: vi.fn(),
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
    getAiBudgetSettings: mocks.getAiBudgetSettings,
    getAiTaskPreferences: mocks.getAiTaskPreferences,
    getAiUsageSummary: mocks.getAiUsageSummary,
    getWritingReviewPolicy: mocks.getWritingReviewPolicy,
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
    mocks.listAiProposals.mockResolvedValueOnce([]).mockResolvedValue([review]);
    mocks.listEntities.mockResolvedValue([]);
    mocks.listJobs.mockResolvedValue([]);
    mocks.listModelProfiles.mockResolvedValue([profile]);
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.generateAiProposal.mockResolvedValue(reviewProposal);
  });

  it("runs a read-only review with the dedicated task settings", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiWritingPanel
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

    const reviewButton = screen.getByRole("button", { name: "开始审核" });
    await waitFor(() => expect(reviewButton).toBeEnabled());
    fireEvent.click(reviewButton);

    await waitFor(() =>
      expect(mocks.generateAiProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "CONSISTENCY_CHECK",
          profileId: profile.id,
          temperature: 0.2,
          maxOutputTokens: 4096,
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
      "/planning#chapter-1",
    );
    expect(screen.getByText("当前没有正文候选待审核")).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭审核" })).toBeVisible();
    expect(screen.getByRole("button", { name: "生成整章初稿" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /应用到正文/ })).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "生成整章初稿" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "按当前内容重新审核" })).toBeEnabled();
    expect(screen.queryByText(/整章创作与续写已暂停/)).not.toBeInTheDocument();
  });

  it("requires a fresh review when the project uses strict admission", async () => {
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

    expect(await screen.findByText(/严格准入/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "生成整章初稿" })).toBeDisabled());
  });
});
