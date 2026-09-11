import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobsView } from "./jobs-view";

const mocks = vi.hoisted(() => ({
  acknowledgeFailedJobs: vi.fn(),
  enqueueJob: vi.fn(),
  listAiRuns: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, acknowledgeFailedJobs: mocks.acknowledgeFailedJobs, enqueueJob: mocks.enqueueJob, listAiRuns: mocks.listAiRuns, listJobs: mocks.listJobs };
});

describe("JobsView", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acknowledgeFailedJobs.mockResolvedValue(1);
    mocks.listAiRuns.mockResolvedValue([]);
    mocks.listJobs.mockResolvedValue([]);
    mocks.enqueueJob.mockResolvedValue({});
  });

  it("uses readable task labels and enqueues the matching task type", async () => {
    render(<QueryClientProvider client={new QueryClient()}><JobsView /></QueryClientProvider>);
    const backup = await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(backup);
    await waitFor(() => expect(mocks.enqueueJob).toHaveBeenCalledWith("BACKUP"));
  });

  it("acknowledges failed job alerts without changing the task list", async () => {
    mocks.listJobs.mockResolvedValue([{
      id: "failed-job",
      jobType: "HEALTH_SCAN",
      payload: "{}",
      status: "FAILED",
      progress: 60,
      attemptCount: 1,
      cancelRequested: false,
      errorSummary: "健康扫描失败",
      createdAt: "2026-09-11T00:00:00Z",
      updatedAt: "2026-09-11T00:00:01Z",
      acknowledgedAt: null,
    }]);

    render(<QueryClientProvider client={new QueryClient()}><JobsView /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "清除失败提醒 1" }));

    await waitFor(() => expect(mocks.acknowledgeFailedJobs).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("健康扫描失败").length).toBeGreaterThan(0);
  });

  it("shows AI writing runs in the task page history", async () => {
    mocks.listAiRuns.mockResolvedValue([{
      id: "run-1",
      taskKey: "writing",
      source: "WRITING",
      action: "DRAFT",
      status: "COMPLETED",
      chapterTitle: "第1章",
      profileName: "写作模型",
      attemptCount: 1,
      retryReason: null,
      errorCode: null,
      estimatedInputTokens: 1200,
      estimatedOutputTokens: 2400,
      estimatedCostMicros: 3500,
      priceCurrency: "USD",
      promptVersion: "writing-v1",
      createdAt: "2026-09-11T00:00:00Z",
      finishedAt: "2026-09-11T00:00:12Z",
    }]);

    render(<QueryClientProvider client={new QueryClient()}><JobsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "AI 运行记录" }));

    expect(await screen.findByText("整章创作 · 第1章")).toBeVisible();
    expect(screen.getByText(/写作模型 · 正文创作/)).toBeVisible();
  });
});
