import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { manuscriptQuery } from "./manuscript-query";

const mocks = vi.hoisted(() => ({ currentManuscript: vi.fn() }));
vi.mock("./tauri-client", () => mocks);

describe("manuscriptQuery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the same cache entry for editing, review and extraction", async () => {
    mocks.currentManuscript.mockResolvedValue({ id: "revision-1" });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    await client.fetchQuery(manuscriptQuery("chapter-1"));
    client.setQueryData(manuscriptQuery("chapter-1").queryKey, { id: "revision-2" });
    expect(await client.fetchQuery(manuscriptQuery("chapter-1"))).toEqual({ id: "revision-2" });
    expect(mocks.currentManuscript).toHaveBeenCalledOnce();
    expect(manuscriptQuery(undefined).enabled).toBe(false);
  });
});
