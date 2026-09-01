import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobsView } from "./jobs-view";

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, enqueueJob: mocks.enqueueJob, listJobs: mocks.listJobs };
});

describe("JobsView", () => {
  beforeEach(() => {
    mocks.listJobs.mockResolvedValue([]);
    mocks.enqueueJob.mockResolvedValue({});
  });

  it("uses readable task labels and enqueues the matching task type", async () => {
    render(<QueryClientProvider client={new QueryClient()}><JobsView /></QueryClientProvider>);
    const backup = await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(backup);
    await waitFor(() => expect(mocks.enqueueJob).toHaveBeenCalledWith("BACKUP"));
  });
});
