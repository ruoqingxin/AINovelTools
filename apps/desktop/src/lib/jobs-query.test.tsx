import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskPollingInterval, useJobs } from "./jobs-query";

const mocks = vi.hoisted(() => ({ listJobs: vi.fn() }));
vi.mock("./tauri-client", () => mocks);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("task polling", () => {
  it("keeps active jobs responsive and backs off when idle", () => {
    expect(taskPollingInterval(undefined)).toBe(15_000);
    expect(taskPollingInterval([])).toBe(15_000);
    expect(taskPollingInterval([{ status: "FAILED" }, { status: "SUCCEEDED" }])).toBe(15_000);
    expect(taskPollingInterval([{ status: "QUEUED" }])).toBe(1_200);
    expect(taskPollingInterval([{ status: "RUNNING" }])).toBe(1_200);
  });

  it("shares requests and only polls from the designated owner", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.listJobs.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => ({ owner: useJobs({ poll: true }), subscriber: useJobs() }), { wrapper });
    await waitFor(() => expect(result.current.owner.isSuccess).toBe(true));
    expect(mocks.listJobs).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(mocks.listJobs).toHaveBeenCalledTimes(2);
    await act(() => client.invalidateQueries({ queryKey: ["jobs"] }));
    expect(mocks.listJobs).toHaveBeenCalledTimes(3);
    expect(result.current.owner.data).toBe(result.current.subscriber.data);
  });
});
