import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePanel } from "./workspace-panel";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WorkspacePanel", () => {
  it("keeps existing panels modal by default without resize controls", () => {
    render(<WorkspacePanel open title="历史版本" onClose={vi.fn()}>内容</WorkspacePanel>);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("supports keyboard resizing within desktop bounds and a non-modal escape action", () => {
    const close = vi.fn();
    render(<WorkspacePanel open modal={false} resizable title="文件导入" closeLabel="收起导入" onClose={close}>内容</WorkspacePanel>);
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveAttribute("aria-modal", "false");
    expect(panel).toHaveAttribute("open");
    const resize = screen.getByRole("separator", { name: "调整文件导入宽度" });
    fireEvent.keyDown(resize, { key: "Home" });
    expect(resize).toHaveAttribute("aria-valuenow", "560");
    fireEvent.keyDown(resize, { key: "ArrowRight" });
    expect(resize).toHaveAttribute("aria-valuenow", "560");
    fireEvent.keyDown(resize, { key: "ArrowLeft", shiftKey: true });
    expect(resize).toHaveAttribute("aria-valuenow", "660");
    fireEvent.keyDown(resize, { key: "End" });
    expect(resize).toHaveAttribute("aria-valuenow", String(window.innerWidth - 144));
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(resize).toHaveAttribute("aria-valuenow", String(window.innerWidth - 144));
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "收起导入" }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("expands leftwards by dragging and stops resizing after release or collapse", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const props = { modal: false, resizable: true, title: "文件导入", onClose: vi.fn(), children: "内容" };
    const { rerender } = render(<WorkspacePanel {...props} open />);
    const panel = screen.getByRole("dialog");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 600 } as DOMRect);
    const resize = screen.getByRole("separator");
    fireEvent.pointerDown(resize, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 400 });
    expect(resize).toHaveAttribute("aria-valuenow", "700");
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(resize).toHaveAttribute("aria-valuenow", "700");
    fireEvent.pointerDown(resize, { button: 0, clientX: 500 });
    rerender(<WorkspacePanel {...props} open={false} />);
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(panel).toHaveAttribute("hidden");
    expect(panel.style.getPropertyValue("--workspace-panel-width")).toBe("700px");
    rerender(<WorkspacePanel {...props} open />);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "700");
  });
});
