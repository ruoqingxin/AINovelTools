import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoryBibleView } from "./story-bible-view";

const mocks = vi.hoisted(() => ({
  listEntities: vi.fn(),
  listEntityRevisions: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    listEntities: mocks.listEntities,
    listEntityRevisions: mocks.listEntityRevisions,
    setEntityArchived: vi.fn(),
    upsertEntity: vi.fn(),
  };
});

describe("StoryBibleView", () => {
  beforeEach(() => {
    mocks.listEntities.mockResolvedValue([]);
    mocks.listEntityRevisions.mockResolvedValue([]);
  });

  it("renders the workspace controls and empty state", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoryBibleView />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Story Bible" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "搜索实体" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "实体类型筛选" })).toBeVisible();
    expect(await screen.findByText("没有符合条件的实体。")).toBeVisible();
  });
});
