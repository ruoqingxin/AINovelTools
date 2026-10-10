import { beforeEach, expect, it, vi } from "vitest";
import { invoke, listen } from "./ipc-transport";

const transport = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: transport.listen }));
beforeEach(() => vi.clearAllMocks());

it("preserves no-argument calls and returns the backend value without normalization", async () => {
  const status = { appVersion: "0.1.0", layers: ["domain", "application", "infrastructure"] };
  transport.invoke.mockResolvedValue(status);
  expect(await invoke("bootstrap_status")).toBe(status);
  expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("bootstrap_status");
});

it("forwards nested CAS scope and unvalidated JSON without modifying the request", async () => {
  const request = {
    target: { id: "item", projectId: "project", chapterId: "chapter", expectedStatus: "PENDING_REVIEW" as const, expectedVersion: 4 },
    payload: { name: "edited" },
  };
  transport.invoke.mockResolvedValue({ ...request.target, payload: request.payload, version: 5 });
  const response = await invoke("update_extraction_item", request);
  expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("update_extraction_item", request);
  expect(response.version).toBe(5);
});

it("does not remap or swallow the actual command error", async () => {
  const error = { code: "VERSION_CONFLICT", message: "changed in another window" };
  transport.invoke.mockRejectedValue(error);
  await expect(invoke("discard_manuscript_draft", { chapterId: "chapter", expectedVersion: 1 })).rejects.toBe(error);
});

it("preserves typed event subscriptions, null payload fields and unlisten handles", async () => {
  const unlisten = vi.fn();
  const payload = { taskId: "task", attempt: 1, profileName: "model", fallbackReason: null };
  transport.listen.mockImplementation(async (event, handler) => {
    handler({ event, id: 1, payload });
    return unlisten;
  });
  const handler = vi.fn();
  expect(await listen("ai-task-attempt", handler)).toBe(unlisten);
  expect(transport.listen).toHaveBeenCalledExactlyOnceWith("ai-task-attempt", handler, undefined);
  expect(handler).toHaveBeenCalledWith({ event: "ai-task-attempt", id: 1, payload });
});
