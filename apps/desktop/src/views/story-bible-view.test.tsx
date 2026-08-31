import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoryBibleView } from "./story-bible-view";

const mocks = vi.hoisted(() => ({
  listEntities: vi.fn(),
  listEntityRevisions: vi.fn(),
  upsertEntity: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    listEntities: mocks.listEntities,
    listEntityRevisions: mocks.listEntityRevisions,
    upsertEntity: mocks.upsertEntity,
    setEntityArchived: vi.fn(),
  };
});

describe("StoryBibleView", () => {
  beforeEach(() => {
    mocks.listEntities.mockResolvedValue([]);
    mocks.listEntityRevisions.mockResolvedValue([]);
    mocks.upsertEntity.mockResolvedValue({
      id: "entity-1",
      projectId: "project-1",
      entityType: "CHARACTER",
      lifecycleStatus: "ACTIVE",
      currentRevisionId: "revision-1",
      version: 1,
      createdAt: "",
      updatedAt: "",
    });
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

  it("reports a successful append-only save", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoryBibleView />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getAllByPlaceholderText("例如：林澈")[0], { target: { value: "林澈" } });
    const saveButton = screen.getAllByRole("button", { name: "创建实体" }).find((button) => !button.hasAttribute("disabled"));
    fireEvent.click(saveButton!);

    await waitFor(() => expect(mocks.upsertEntity).toHaveBeenCalledWith(expect.objectContaining({ name: "林澈" })));
    expect(await screen.findByText("已保存为新修订")).toBeVisible();
  });
});
