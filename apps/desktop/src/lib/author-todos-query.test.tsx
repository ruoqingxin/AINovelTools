import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { todoHref, useAuthorTodos } from "./author-todos-query";
import type { AuthorTodo } from "./tauri-client";
const mocks = vi.hoisted(() => ({ listAuthorTodos: vi.fn() }));
vi.mock("./tauri-client", async () => ({ ...await vi.importActual<typeof import("./tauri-client")>("./tauri-client"), ...mocks }));
afterEach(cleanup);
describe("shared author queue", () => {
  it("shares one source of counts and refreshes after canonical records change", async () => {
    mocks.listAuthorTodos.mockResolvedValue({ pendingCount: 2, items: [], projectId: "p" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => [useAuthorTodos({ poll: true }), useAuthorTodos()], {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current[0].data?.pendingCount).toBe(2));
    expect(result.current[0].data).toBe(result.current[1].data);
    mocks.listAuthorTodos.mockResolvedValue({ pendingCount: 1, items: [], projectId: "p" });
    act(() => client.setQueryData(["knowledge-candidates", "chapter"], []));
    await waitFor(() => expect(result.current[1].data?.pendingCount).toBe(1));
  });
  it.each([
    ["FACT_REVIEW", "knowledge=facts"], ["FACT_FINALIZE", "knowledge=facts"], ["RECOVERY", "tab=versions"],
    ["WRITING_PROPOSAL", "assistant=ai"], ["EXTRACTION", "tab=extraction"], ["EXTRACTION_DEFERRED", "tab=extraction"],
    ["DISCUSSION_DESIGN", "design=results"],
  ])("links %s to its canonical existing handler", (kind, parameter) => {
    const href = todoHref({ kind, targetId: "exact" } as AuthorTodo, "project");
    expect(href).toContain(parameter);
    expect(href).toContain("targetProject=project");
    expect(href).toContain("returnTo=%2Freview");
    expect(href).toContain("#exact");
  });
});
