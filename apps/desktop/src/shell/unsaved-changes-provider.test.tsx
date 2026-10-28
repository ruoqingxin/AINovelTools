import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider, useUnsavedChangesGuard } from "./unsaved-changes-provider";
import { WorkspaceLink } from "../views/workspace-link";

function Editor() {
  const [text, setText] = useState("");
  useUnsavedChangesGuard(Boolean(text), "主线大纲尚未保存。");
  return <input aria-label="规划草稿" value={text} onChange={(event) => setText(event.target.value)} />;
}
function Planning() {
  const mode = useRouterState({ select: (state) => state.location.searchStr });
  return <><Link to="/planning" search={{ mode: "structure" }}>切换分卷</Link><Editor key={mode} /></>;
}
function Discussion() {
  const target = useRouterState({ select: (state) => state.location.searchStr });
  return <><WorkspaceLink href="/discussion?work=entity&entity=second">切换设定对象</WorkspaceLink>
    <WorkspaceLink href="/discussion?work=materials">切换内容分类</WorkspaceLink><Editor key={target} /></>;
}
describe("planning mode navigation guard", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("checks current dirty entries even from a previously registered native leave guard", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const root = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> });
    const route = createRoute({ getParentRoute: () => root, path: "/planning", component: Editor });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/planning"] }) });
    const block = vi.spyOn(router.history, "block");
    render(<RouterProvider router={router} />);
    const input = await screen.findByRole("textbox", { name: "规划草稿" });
    fireEvent.change(input, { target: { value: "未保存" } });
    await waitFor(() => expect(block).toHaveBeenCalled());
    const nativeGuard = block.mock.calls[block.mock.calls.length - 1][0].enableBeforeUnload;
    expect(typeof nativeGuard).toBe("function");
    if (typeof nativeGuard !== "function") throw new Error("Expected a live native leave guard");
    expect(nativeGuard()).toBe(true);
    fireEvent.change(input, { target: { value: "" } });
    expect(nativeGuard()).toBe(false);
    fireEvent.change(input, { target: { value: "新的未保存内容" } });
    expect(nativeGuard()).toBe(true);
  });
  it("can cancel a same-route mode switch and retains author input", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const root = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> });
    const route = createRoute({ getParentRoute: () => root, path: "/planning", validateSearch: (search: Record<string, unknown>) => search, component: Planning });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/planning?mode=prepare"] }) });
    render(<RouterProvider router={router} />);
    const input = await screen.findByRole("textbox", { name: "规划草稿" });
    fireEvent.change(input, { target: { value: "作者仍在修改" } });
    fireEvent.click(screen.getByRole("link", { name: "切换分卷" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("主线大纲尚未保存");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("作者仍在修改");
    expect(router.state.location.searchStr).toBe("?mode=prepare");
    fireEvent.click(screen.getByRole("link", { name: "切换分卷" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃修改并离开" }));
    await waitFor(() => expect(router.state.location.searchStr).toBe("?mode=structure"));
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue("");
  });
  it.each(["切换设定对象", "切换内容分类"])("guards same-route AI workspace navigation: %s", async (link) => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const root = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> });
    const route = createRoute({ getParentRoute: () => root, path: "/discussion",
      validateSearch: (search: Record<string, unknown>) => search, component: Discussion });
    const router = createRouter({ routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/discussion?work=entity&entity=first"] }) });
    render(<RouterProvider router={router} />);
    const input = await screen.findByRole("textbox", { name: "规划草稿" });
    fireEvent.change(input, { target: { value: "正在处理的内容" } });
    fireEvent.click(screen.getByRole("link", { name: link }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("正在处理的内容");
    expect(router.state.location.searchStr).toBe("?work=entity&entity=first");
    fireEvent.click(screen.getByRole("link", { name: link }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃修改并离开" }));
    await waitFor(() => expect(router.state.location.searchStr).toBe(
      link === "切换设定对象" ? "?work=entity&entity=second" : "?work=materials"));
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue("");
  });
});
