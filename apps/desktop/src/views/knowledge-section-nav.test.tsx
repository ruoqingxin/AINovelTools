import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider, useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { KnowledgeSectionNav } from "./knowledge-section-nav";

const sections = [
  ["/knowledge", "设定"],
  ["/knowledge/settings", "设定揭示状态"],
  ["/knowledge/records", "剧情记录"],
  ["/knowledge/materials", "辅助参考"],
] as const;

function Pane({ label }: { label: string }) {
  const [draft, setDraft] = useState("");
  useUnsavedChangesGuard(Boolean(draft), "资料尚未保存。");
  return <><h1>{label}</h1><input aria-label="资料编辑" value={draft} onChange={(event) => setDraft(event.target.value)} /></>;
}

function setup(path = "/knowledge") {
  const root = createRootRoute({
    component: () => <UnsavedChangesProvider>
      <input aria-label="持久工具栏" defaultValue="unchanged" />
      <KnowledgeSectionNav /><Outlet />
    </UnsavedChangesProvider>,
  });
  const tree = root.addChildren(sections.map(([url, label]) => createRoute({
    getParentRoute: () => root, path: url, component: () => <Pane label={label} />,
  })));
  const router = createRouter({
    routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }), defaultPendingMinMs: 0,
  });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => { vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("knowledge section navigation", () => {
  it("switches all categories inside the router without replacing the persistent shell", async () => {
    const router = setup();
    await screen.findByRole("heading", { name: "设定" });
    const toolbar = screen.getByLabelText("持久工具栏");
    fireEvent.change(toolbar, { target: { value: "keep shell" } });
    for (const [path, label] of [...sections.slice(1), sections[0]]) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("href", path);
      expect(fireEvent.click(link)).toBe(false);
      await screen.findByRole("heading", { name: label });
      expect(router.state.location.pathname).toBe(path);
      expect(link).toHaveAttribute("aria-current", "page");
      expect(link).toHaveAttribute("data-active", "true");
      expect(screen.getByLabelText("持久工具栏")).toBe(toolbar);
      expect(toolbar).toHaveValue("keep shell");
      expect(document.querySelectorAll('.knowledge-section-link[aria-current="page"]')).toHaveLength(1);
    }
  });

  it("marks the exact category for a direct link with search parameters", async () => {
    setup("/knowledge/materials?summary=summary-1");
    await screen.findByRole("heading", { name: "辅助参考" });
    expect(screen.getByRole("link", { name: "辅助参考" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: "设定" })).not.toHaveAttribute("data-active");
  });

  it("keeps unsaved edits on cancellation and navigates only after approval", async () => {
    const router = setup();
    await screen.findByRole("heading", { name: "设定" });
    fireEvent.change(screen.getByLabelText("资料编辑"), { target: { value: "unsaved entity" } });
    fireEvent.click(screen.getByRole("link", { name: "设定揭示状态" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("资料尚未保存");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/knowledge");
    expect(screen.getByLabelText("资料编辑")).toHaveValue("unsaved entity");
    fireEvent.click(screen.getByRole("link", { name: "设定揭示状态" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    await screen.findByRole("heading", { name: "设定揭示状态" });
    expect(router.state.location.pathname).toBe("/knowledge/settings");
    expect(screen.getByLabelText("资料编辑")).toHaveValue("");
  });
});
