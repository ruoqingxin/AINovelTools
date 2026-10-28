import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobsView } from "./jobs-view";
const mocks = vi.hoisted(() => ({
  acknowledgeFailedJobs: vi.fn(), cancelJob: vi.fn(), retryJob: vi.fn(), getCurrentProject: vi.fn(),
  getAiRunRequest: vi.fn(), listAiRuns: vi.fn(), listJobs: vi.fn(), listJobEvents: vi.fn(), listPlanNodes: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks }));
const job = { id: "failed-job", jobType: "HEALTH_SCAN", payload: "{}", status: "FAILED", progress: 60, attemptCount: 1,
  cancelRequested: false, errorSummary: "健康扫描失败", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:01Z", acknowledgedAt: null };
const run = {
  id: "run-1", taskKey: "writing", source: "WRITING", action: "DRAFT", status: "COMPLETED",
  chapterId: "chapter-1", chapterTitle: "第1章", profileName: "写作模型", attemptCount: 1,
  retryReason: null, errorCode: null, estimatedInputTokens: 1200, estimatedOutputTokens: 2400,
  estimatedCostMicros: 3500, priceCurrency: "USD", promptVersion: "writing-v1",
  createdAt: "2026-10-13T00:00:00Z", finishedAt: "2026-10-13T00:00:12Z",
};
function renderView() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JobsView /></QueryClientProvider>);
}
describe("background activity", () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, "", "/jobs"); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acknowledgeFailedJobs.mockResolvedValue(1);
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1", name: "铜铃之城" });
    mocks.listPlanNodes.mockResolvedValue([]);
    mocks.listJobEvents.mockResolvedValue([]);
    mocks.listAiRuns.mockResolvedValue([]);
    mocks.listJobs.mockResolvedValue([]);
  });
  it("has no manual runner, maintenance creation, or quality tab", async () => {
    renderView();
    await screen.findByText("当前筛选没有后台任务");
    expect(screen.queryByRole("button", { name: /执行下一项|创建备份/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /质量/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用量与效果" })).toHaveAttribute("href", "/settings#ai-usage");
  });
  it("clears reminders without removing failures and puts IDs in advanced details", async () => {
    mocks.listJobs.mockResolvedValue([job]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "清除失败提醒 1" }));
    await waitFor(() => expect(mocks.acknowledgeFailedJobs).toHaveBeenCalledOnce());
    expect(screen.getByText("健康扫描失败")).toBeVisible();
    expect(screen.getByText(job.id)).not.toBeVisible();
    fireEvent.click(screen.getByText("高级详情"));
    expect(screen.getByText(job.id)).toBeVisible();
  });
  it("preserves retry and cancellation with exactly one action per selected task", async () => {
    mocks.listJobs.mockResolvedValue([job]);
    mocks.retryJob.mockResolvedValue({ ...job, status: "QUEUED" });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.retryJob).toHaveBeenCalledWith(job.id));
    mocks.listJobs.mockResolvedValue([{ ...job, status: "RUNNING", errorSummary: null }]);
    fireEvent.click(screen.getByLabelText("刷新任务"));
    fireEvent.click(await screen.findByRole("button", { name: "取消任务" }));
    await waitFor(() => expect(mocks.cancelJob).toHaveBeenCalledWith(job.id));
  });
  it("opens a requested cancelled task from maintenance history", async () => {
    window.history.replaceState({}, "", "/jobs?jobId=failed-job");
    mocks.listJobs.mockResolvedValue([{ ...job, status: "CANCELLED", errorSummary: null }]);
    renderView();
    expect(await screen.findByText("任务已取消")).toBeVisible();
  });
  it("recovers a filtered empty state without deleting cancelled tasks", async () => {
    mocks.listJobs.mockResolvedValue([{ ...job, status: "CANCELLED", errorSummary: null }]);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "查看全部记录" }));
    expect(screen.getByLabelText("活动状态")).toHaveValue("ALL");
    expect(await screen.findByText("任务已取消")).toBeVisible();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
  });
  it("retries a failed activity query inline", async () => {
    mocks.listJobs.mockRejectedValueOnce(new Error("任务读取失败"));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("任务读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByText("当前筛选没有后台任务")).toBeVisible();
  });
  it("shows AI records with lazy request snapshots and no default technical fields", async () => {
    mocks.listAiRuns.mockResolvedValue([run]);
    mocks.getAiRunRequest.mockResolvedValue({ endpoint: "https://example.test/chat", requestBody: '{"model":"mock"}' });
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "AI 运行记录" }));
    expect(await screen.findByText("整章创作 · 第1章")).toBeVisible();
    expect(screen.getByText("writing-v1")).not.toBeVisible();
    expect(mocks.getAiRunRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("高级详情"));
    fireEvent.click(screen.getByRole("button", { name: "查看完整请求" }));
    expect(await screen.findByText('{"model":"mock"}')).toBeVisible();
    expect(screen.getByText("12 秒")).toBeVisible();
  });
  it.each(["WRITING", "KNOWLEDGE_EXTRACTION"])("opens %s results in the exact AI workspace and returns to activity", async (source) => {
    window.history.replaceState({}, "", "/jobs#ai-runs");
    mocks.listAiRuns.mockResolvedValue([{ ...run, source, chapterId: "chapter:1 & two" }]);
    renderView();
    const link = await screen.findByRole("link", { name: "打开处理工作区" });
    const href = new URL(link.getAttribute("href")!, window.location.origin);
    expect(href.pathname).toBe("/discussion");
    expect(href.searchParams.get("targetProject")).toBe("project-1");
    expect(href.searchParams.get("planNode")).toBe("chapter:1 & two");
    expect(href.searchParams.get("returnTo")).toBe("/jobs#ai-runs");
    expect(href.searchParams.get(source === "WRITING" ? "assistant" : "tab")).toBe(source === "WRITING" ? "ai" : "extraction");
    expect(screen.queryByRole("link", { name: "打开章节" })).not.toBeInTheDocument();
  });
  it("does not offer an unscoped AI target before the current project is known", async () => {
    window.history.replaceState({}, "", "/jobs#ai-runs");
    mocks.listAiRuns.mockResolvedValue([run]);
    mocks.getCurrentProject.mockResolvedValue(null);
    renderView();
    await screen.findByText("整章创作 · 第1章");
    expect(screen.queryByRole("link", { name: "打开处理工作区" })).not.toBeInTheDocument();
  });
  it("shows progress in the list only for active jobs while retaining failed detail progress", async () => {
    mocks.listJobs.mockResolvedValue([job, { ...job, id: "active", status: "RUNNING", progress: 20, errorSummary: null }]);
    renderView();
    const failed = await screen.findByRole("button", { name: "检查数据健康 铜铃之城 失败" });
    expect(failed.querySelector(".job-progress")).toBeNull();
    const active = screen.getByRole("button", { name: /检查数据健康 铜铃之城 执行中/ });
    expect(active.querySelector(".job-progress")).not.toBeNull();
    fireEvent.click(failed);
    expect(screen.getByRole("progressbar", { name: "任务进度" })).toHaveAttribute("value", "60");
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });
});
