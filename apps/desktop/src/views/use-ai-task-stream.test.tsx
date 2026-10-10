import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRun } from "../lib/tauri-client";
import { useAiTaskStream } from "./use-ai-task-stream";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), listAiRuns: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"),
  listAiRuns: mocks.listAiRuns,
}));

type StreamOptions = Parameters<typeof useAiTaskStream>[0];
const options: StreamOptions = {
  chapterId: "chapter-1", active: true, enabled: true, busy: false,
  taskKey: "consistencyReview", reviewPurpose: "ADMISSION",
};
function setup(initial = options) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook((props: StreamOptions) => useAiTaskStream(props), { initialProps: initial, wrapper }) };
}

describe("AI task stream ownership", () => {
  const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
  const unlisten = vi.fn();
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.resetAllMocks();
    listeners.clear();
    mocks.listAiRuns.mockResolvedValue([]);
    mocks.listen.mockImplementation(async (name, callback) => {
      listeners.set(name, callback);
      return unlisten;
    });
  });
  function emit(name: string, payload: Record<string, unknown>) {
    act(() => listeners.get(name)!({ payload }));
  }

  it.each([{ active: false }, { enabled: false }])("does not subscribe or read runs when disabled: %j", async (flags) => {
    setup({ ...options, ...flags });
    await act(async () => {});
    expect(mocks.listAiRuns).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("locks for another purpose without adopting its task or stream", async () => {
    mocks.listAiRuns.mockResolvedValue([{
      id: "manuscript-task", chapterId: "chapter-1", taskKey: "consistencyReview",
      status: "RUNNING", reviewPurpose: "MANUSCRIPT",
    } as AiRun]);
    const { result } = setup();
    await waitFor(() => expect(mocks.listAiRuns).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(result.current.generationLocked).toBe(true);
    expect(result.current.generationBusy).toBe(false);
    expect(result.current.effectiveTaskId).toBeNull();
    emit("ai-task-chunk", { taskId: "manuscript-task", chunk: "other report" });
    expect(result.current.preview).toBe("");
  });

  it("resets only its own preview on fallback and ignores other tasks", async () => {
    const { result } = setup();
    await waitFor(() => expect(listeners.size).toBe(3));
    act(() => result.current.beginRequest());
    emit("ai-task-started", { taskId: "own-task" });
    emit("ai-task-chunk", { taskId: "own-task", chunk: "first attempt" });
    emit("ai-task-attempt", { taskId: "foreign-task", attempt: 2, profileName: "foreign" });
    expect(result.current.preview).toBe("first attempt");
    expect(result.current.fallbackNotice).toBeNull();
    emit("ai-task-attempt", { taskId: "own-task", attempt: 2, profileName: "backup", fallbackReason: "TIMEOUT" });
    expect(result.current.preview).toBe("");
    expect(result.current.fallbackNotice).toContain("TIMEOUT");
    emit("ai-task-chunk", { taskId: "own-task", chunk: "second attempt" });
    emit("ai-task-started", { taskId: "foreign-task" });
    expect(result.current.preview).toBe("second attempt");
    act(() => result.current.finishRequest());
  });

  it("retains listeners while its own request is busy and releases them when hidden and idle", async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(listeners.size).toBe(3));
    act(() => result.current.beginRequest());
    emit("ai-task-started", { taskId: "own-task" });
    rerender({ ...options, active: false, busy: true });
    expect(unlisten).not.toHaveBeenCalled();
    emit("ai-task-chunk", { taskId: "own-task", chunk: "hidden result" });
    expect(result.current.preview).toBe("hidden result");
    act(() => result.current.finishRequest());
    rerender({ ...options, active: false });
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(3));
  });

  it("releases late subscriptions after unmount and ignores disposed callbacks", async () => {
    const resolvers: Array<(callback: () => void) => void> = [];
    mocks.listen.mockImplementation((name, callback) => {
      listeners.set(name, callback);
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const { client, unmount } = setup();
    await waitFor(() => expect(resolvers).toHaveLength(3));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    unmount();
    emit("ai-task-started", { taskId: "late-task" });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => resolvers.forEach((resolve) => resolve(unlisten)));
    expect(unlisten).toHaveBeenCalledTimes(3);
  });
});
