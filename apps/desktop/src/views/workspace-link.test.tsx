import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLink } from "./workspace-link";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });

describe("WorkspaceLink", () => {
  it("keeps standalone and external links as native anchors", () => {
    render(<><WorkspaceLink href="/discussion?work=entity#person">设定</WorkspaceLink>
      <WorkspaceLink href="https://example.com/" target="_blank" rel="noreferrer">外部来源</WorkspaceLink></>);
    expect(screen.getByRole("link", { name: "设定" })).toHaveAttribute("href", "/discussion?work=entity#person");
    expect(screen.getByRole("link", { name: "外部来源" })).toHaveAttribute("target", "_blank");
  });

  it("preserves search and hash with application navigation and leaves the shell mounted", async () => {
    const root = createRootRoute({ component: () => <><input aria-label="保留的工作区状态" /><Outlet /></> });
    const entry = createRoute({ getParentRoute: () => root, path: "/",
      component: () => <WorkspaceLink href="/discussion?work=entity&entity=person&returnTo=%2Fwriting%23chapter#session">处理设定</WorkspaceLink> });
    const discussion = createRoute({ getParentRoute: () => root, path: "/discussion",
      validateSearch: (search: Record<string, unknown>) => search, component: () => <p>已进入设定</p> });
    const router = createRouter({ routeTree: root.addChildren([entry, discussion]),
      history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<RouterProvider router={router} />);
    const shellInput = await screen.findByLabelText("保留的工作区状态");
    fireEvent.change(shellInput, { target: { value: "继续保留" } });
    fireEvent.click(screen.getByRole("link", { name: "处理设定" }));
    await screen.findByText("已进入设定");
    expect(router.state.location.search).toEqual({ work: "entity", entity: "person", returnTo: "/writing#chapter" });
    expect(router.state.location.hash).toBe("session");
    expect(screen.getByLabelText("保留的工作区状态")).toBe(shellInput);
    expect(shellInput).toHaveValue("继续保留");
    await router.history.back();
    await waitFor(() => expect(screen.getByRole("link", { name: "处理设定" })).toBeVisible());
  });

  it("does not mark discussion or manuscript as active when editing a chapter plan", async () => {
    const root = createRootRoute({ component: Outlet });
    const discussion = createRoute({ getParentRoute: () => root, path: "/discussion",
      component: () => <nav aria-label="内容分类">
        <WorkspaceLink href="/discussion">自由构思</WorkspaceLink>
        <WorkspaceLink href="/discussion?work=writing&targetProject=p">正文</WorkspaceLink>
        <WorkspaceLink href="/discussion?work=planning&targetProject=p" aria-current="page">大纲</WorkspaceLink>
      </nav> });
    const router = createRouter({ routeTree: root.addChildren([discussion]),
      history: createMemoryHistory({ initialEntries: ["/discussion?work=writing&targetProject=p&planNode=chapter&tab=plan"] }) });
    render(<RouterProvider router={router} />);
    await screen.findByRole("navigation", { name: "内容分类" });
    expect(screen.getByRole("link", { name: "自由构思" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "正文" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "大纲" })).toHaveAttribute("aria-current", "page");
  });
});
