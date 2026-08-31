import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialsView } from "./materials-view";

const mocks = vi.hoisted(() => ({
  listSummaryMaterials: vi.fn(),
  listWritingCards: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    listSummaryMaterials: mocks.listSummaryMaterials,
    listWritingCards: mocks.listWritingCards,
  };
});

describe("MaterialsView", () => {
  beforeEach(() => {
    mocks.listSummaryMaterials.mockResolvedValue([]);
    mocks.listWritingCards.mockResolvedValue([]);
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
});
