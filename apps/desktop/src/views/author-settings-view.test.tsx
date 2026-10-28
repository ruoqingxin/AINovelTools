import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorSettingsView } from "./author-settings-view";
vi.mock("./knowledge-section-nav", () => ({ KnowledgeSectionNav: () => null }));
const mocks = vi.hoisted(() => ({ listAuthorSettings: vi.fn(), getCurrentProject: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
describe("AuthorSettingsView", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => { vi.resetAllMocks(); mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" }); });
  it("keeps author-only settings distinct and links the exact entity and source discussion", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listAuthorSettings.mockResolvedValue([
      { id: "secret", entityId: "entity-1", entityName: "吞声灯", content: "作者秘密，尚未揭示",
        visibility: "AUTHOR_ONLY", sessionId: "session-1", entityRevisionId: "revision-1", sourceProposalId: "proposal-1" },
      { id: "public", entityId: "entity-2", entityName: "北境", content: "可揭示设定", visibility: "PUBLIC", sessionId: "session-2" },
    ]);
    render(<QueryClientProvider client={new QueryClient()}><AuthorSettingsView /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /吞声灯/ }));
    expect(screen.getByText("作者确认 · 尚未揭示")).toBeVisible();
    const href = new URL(screen.getByRole("link", { name: "关联人物或世界资料" }).getAttribute("href")!, window.location.origin);
    expect(href.searchParams.get("entity")).toBe("entity-1");
    expect(href.searchParams.get("targetProject")).toBe("project-1");
    expect(href.searchParams.get("returnTo")).toBe("/knowledge/settings");
    expect(screen.getByRole("link", { name: "来源讨论" })).toHaveAttribute("href", "/discussion#session-1");
    fireEvent.change(screen.getByLabelText("设定公开状态"), { target: { value: "AUTHOR_ONLY" } });
    expect(screen.queryByRole("button", { name: /北境/ })).not.toBeInTheDocument();
  });
  it("clears and resets filters while preserving the selected author-only setting", async () => {
    mocks.listAuthorSettings.mockResolvedValue([
      { id: "secret", entityId: "entity-1", entityName: "吞声灯", content: "作者秘密",
        visibility: "AUTHOR_ONLY", sessionId: "session-1" },
    ]);
    render(<QueryClientProvider client={new QueryClient()}><AuthorSettingsView /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /吞声灯/ }));
    fireEvent.change(screen.getByLabelText("搜索作者设定"), { target: { value: "不存在" } });
    fireEvent.click(screen.getByRole("button", { name: "清空搜索作者设定" }));
    expect(screen.getByLabelText("搜索作者设定")).toHaveFocus();
    expect(screen.getByRole("button", { name: /吞声灯/ })).toBeVisible();
    fireEvent.change(screen.getByLabelText("设定公开状态"), { target: { value: "PUBLIC" } });
    expect(screen.getByText("没有符合条件的作者设定。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(screen.getByLabelText("设定公开状态")).toHaveValue("ALL");
    expect(screen.getByRole("heading", { name: "吞声灯" })).toBeVisible();
    expect(screen.getByText("作者确认 · 尚未揭示")).toBeVisible();
  });
  it("does not ask authors to select a setting when the library is empty", async () => {
    mocks.listAuthorSettings.mockResolvedValue([]);
    render(<QueryClientProvider client={new QueryClient()}><AuthorSettingsView /></QueryClientProvider>);
    expect(await screen.findByText("尚未添加作者设定")).toBeVisible();
    expect(screen.queryByText("选择一条作者设定")).not.toBeInTheDocument();
  });
  it("opens reveal details separately on mobile and restores the filtered list and focus", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    mocks.listAuthorSettings.mockResolvedValue([
      { id: "secret", entityId: "entity-1", entityName: "吞声灯", content: "尚未揭示的秘密",
        visibility: "AUTHOR_ONLY", sessionId: "session-1" },
    ]);
    render(<QueryClientProvider client={new QueryClient()}><AuthorSettingsView /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("搜索作者设定"), { target: { value: "吞声" } });
    const item = await screen.findByRole("button", { name: /吞声灯/ });
    const list = screen.getByRole("complementary", { name: "作者设定列表" });
    list.scrollTop = 80;
    fireEvent.click(item);
    expect(list).not.toBeVisible();
    expect(screen.getByRole("region", { name: "设定揭示详情" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "搜索作者设定" })).not.toBeInTheDocument();
    expect(screen.getByText("作者确认 · 尚未揭示")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回设定列表" }));
    expect(screen.getByLabelText("搜索作者设定")).toHaveValue("吞声");
    await waitFor(() => expect(item).toHaveFocus());
    expect(list.scrollTop).toBe(80);
  });
});
