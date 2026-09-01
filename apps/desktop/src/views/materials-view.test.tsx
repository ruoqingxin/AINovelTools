import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialsView } from "./materials-view";

const mocks = vi.hoisted(() => ({
  listSummaryMaterials: vi.fn(),
  listWritingCards: vi.fn(),
  setSummaryMaterialLifecycle: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    listSummaryMaterials: mocks.listSummaryMaterials,
    listWritingCards: mocks.listWritingCards,
    setSummaryMaterialLifecycle: mocks.setSummaryMaterialLifecycle,
  };
});

describe("MaterialsView", () => {
  beforeEach(() => {
    mocks.listSummaryMaterials.mockResolvedValue([]);
    mocks.listWritingCards.mockResolvedValue([]);
    mocks.setSummaryMaterialLifecycle.mockResolvedValue({});
  });

  it("renders summary and writing-card management panels", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MaterialsView />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "摘要与写作卡片" })).toBeVisible();
    expect(screen.getByRole("button", { name: "保存摘要" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存卡片" })).toBeDisabled();
    expect(await screen.findByText("新建摘要")).toBeVisible();
    expect(screen.getByText("写作卡片")).toBeVisible();
  });

  it("uses an explicit activate action for candidate summaries", async () => {
    mocks.listSummaryMaterials.mockResolvedValue([{
      id: "summary-1", projectId: "project-1", kind: "CHAPTER", precision: "L0",
      sourceId: null, sourceVersion: null, content: "候选摘要", generationMode: "AI",
      lifecycleStatus: "CANDIDATE", createdAt: "", updatedAt: "",
    }]);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MaterialsView />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "设为有效" }));
    await waitFor(() => expect(mocks.setSummaryMaterialLifecycle).toHaveBeenCalledWith("summary-1", "ACTIVE"));
    expect(screen.getByRole("status")).toHaveTextContent("摘要已设为有效");
  });
});
