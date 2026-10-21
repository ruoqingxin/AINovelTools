import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField } from "./search-field";

afterEach(cleanup);

describe("SearchField", () => {
  function Harness({ onKeyDown = vi.fn() } = {}) {
    const [value, setValue] = useState("雾城");
    return <div onKeyDown={onKeyDown}><SearchField label="搜索章节" value={value} onChange={setValue} /></div>;
  }
  it("clears and returns focus without removing the control's layout space", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "清空搜索章节" }));
    expect(screen.getByLabelText("搜索章节")).toHaveValue("");
    expect(screen.getByLabelText("搜索章节")).toHaveFocus();
    expect(document.querySelector(".search-field-clear")).toBeDisabled();
    expect(document.querySelector(".search-field-clear")).not.toBeVisible();
  });
  it("uses the first Escape to clear a query without closing its containing panel", () => {
    const parentKey = vi.fn();
    render(<Harness onKeyDown={parentKey} />);
    fireEvent.keyDown(screen.getByLabelText("搜索章节"), { key: "Escape" });
    expect(screen.getByLabelText("搜索章节")).toHaveValue("");
    expect(parentKey).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("搜索章节"), { key: "Escape" });
    expect(parentKey).toHaveBeenCalledOnce();
  });
  it("does not clear text while an IME composition is active", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByLabelText("搜索章节"), { key: "Escape", isComposing: true });
    expect(screen.getByLabelText("搜索章节")).toHaveValue("雾城");
  });
});
