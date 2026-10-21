import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider, useUnsavedChangesGuard } from "./unsaved-changes-provider";

function Editor() {
  const [text, setText] = useState("");
  useUnsavedChangesGuard(Boolean(text), "主线大纲尚未保存。");
  return <input aria-label="规划草稿" value={text} onChange={(event) => setText(event.target.value)} />;
}
function Planning() {
  const mode = useRouterState({ select: (state) => state.location.searchStr });
  return <><Link to="/planning" search={{ mode: "structure" }}>切换分卷</Link><Editor key={mode} /></>;
}
describe("planning mode navigation guard", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
});
