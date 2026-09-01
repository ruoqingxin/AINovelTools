import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterWorkspaceTabs } from "./chapter-workspace-tabs";

describe("ChapterWorkspaceTabs", () => {
  it("shows stable work areas and reports tab changes", () => {
    const onChange = vi.fn();
    render(<ChapterWorkspaceTabs value="editor" onChange={onChange} recoveryCount={2} />);

    expect(screen.getByRole("tab", { name: "正文编辑" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "正文编辑" })).toHaveAttribute("aria-controls", "chapter-panel-editor");
    expect(screen.getByLabelText("2 条恢复草稿")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "AI 创作" }));
    expect(onChange).toHaveBeenCalledWith("ai");
  });
});
