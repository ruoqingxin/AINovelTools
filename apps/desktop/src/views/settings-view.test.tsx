import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./settings-view";

const mocks = vi.hoisted(() => ({ listModelProfiles: vi.fn() }));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, listModelProfiles: mocks.listModelProfiles };
});

describe("SettingsView", () => {
  beforeEach(() => mocks.listModelProfiles.mockResolvedValue([]));

  it("places model API configuration under settings", async () => {
    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    expect(screen.getByRole("heading", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "模型 API" })).toHaveAttribute("data-active");
    expect(await screen.findByRole("heading", { name: "模型 API" })).toBeVisible();
    expect(screen.getByLabelText("新建模型配置")).toBeVisible();
  });
});
