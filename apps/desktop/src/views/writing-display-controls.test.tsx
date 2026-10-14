import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritingDisplayControls } from "./writing-display-controls";

describe("WritingDisplayControls", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(cleanup);
  it("updates preferences and dismisses the menu using Escape and outside click", () => {
    render(<WritingDisplayControls focused={false} onFocusChange={vi.fn()} />);
    const menu = document.querySelector("details")!;
    menu.open = true;
    fireEvent.change(screen.getByLabelText("正文字号"), { target: { value: "20" } });
    expect(screen.getByLabelText("正文字号")).toHaveValue("20");
    fireEvent.pointerDown(screen.getByLabelText("正文字号"));
    expect(menu.open).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(screen.getByLabelText("写作显示设置")).toHaveFocus();
    menu.open = true;
    fireEvent.pointerDown(document.body);
    expect(menu.open).toBe(false);
  });
  it("closes the menu before focusing and provides a direct exit", () => {
    const focus = vi.fn();
    const view = render(<WritingDisplayControls focused={false} onFocusChange={focus} />);
    document.querySelector("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: "进入专注模式" }));
    expect(document.querySelector("details")!.open).toBe(false);
    expect(focus).toHaveBeenCalledWith(true);
    view.rerender(<WritingDisplayControls focused onFocusChange={focus} />);
    fireEvent.click(screen.getByRole("button", { name: "退出专注模式" }));
    expect(focus).toHaveBeenLastCalledWith(false);
  });
});
