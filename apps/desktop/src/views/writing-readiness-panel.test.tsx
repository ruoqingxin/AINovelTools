import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAiTaskPreferences } from "../lib/ai-task-preferences";
import { assessWritingReadiness } from "../lib/writing-readiness";
import type { ModelProfile } from "../lib/tauri-client";
import { WritingReadinessPanel } from "./writing-readiness-panel";

const mocks = vi.hoisted(() => ({
  enqueuePlanningAiJob: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  listJobs: vi.fn(),
  listModelProfiles: vi.fn(),
  retryJob: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    enqueuePlanningAiJob: mocks.enqueuePlanningAiJob,
    getAiTaskPreferences: mocks.getAiTaskPreferences,
    listJobs: mocks.listJobs,
    listModelProfiles: mocks.listModelProfiles,
    retryJob: mocks.retryJob,
  };
});

const profile: ModelProfile = {
  id: "planning-profile",
  name: "规划模型",
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
  secretRef: "model-profile:planning-profile",
  hasSecret: true,
  createdAt: "0",
  updatedAt: "0",
};

describe("WritingReadinessPanel", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    const preferences = structuredClone(emptyAiTaskPreferences);
    preferences.workDesign.profileId = profile.id;
    mocks.enqueuePlanningAiJob.mockResolvedValue({});
    mocks.getAiTaskPreferences.mockResolvedValue(preferences);
    mocks.listJobs.mockResolvedValue([]);
    mocks.listModelProfiles.mockResolvedValue([profile]);
    mocks.retryJob.mockResolvedValue({});
  });

  it("submits an AI planning job for a missing creation requirement", async () => {
    const readiness = assessWritingReadiness({
      sections: [],
      hasCharacterCard: false,
      hasChapterPlan: false,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WritingReadinessPanel
          chapterId="chapter-1"
          readiness={readiness}
          loading={false}
          sections={[]}
        />
      </QueryClientProvider>,
    );

    const row = (await screen.findByText("核心前提与开局情境")).closest("article");
    expect(row).not.toBeNull();
    fireEvent.click(await within(row!).findByRole("button", { name: "AI 补这项" }));

    await waitFor(() =>
      expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: profile.id,
          sectionId: "seed-premise",
          taskKey: "workDesign",
        }),
      ),
    );
  });
});
