import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorSettingsView } from "./author-settings-view";
vi.mock("./knowledge-section-nav", () => ({ KnowledgeSectionNav: () => null }));
const mocks = vi.hoisted(() => ({ listAuthorSettings: vi.fn(), getCurrentProject: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
describe("AuthorSettingsView", () => {
  afterEach(cleanup);
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
});
