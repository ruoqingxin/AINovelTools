import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterWorkspaceTabs } from "./chapter-workspace-tabs";

describe("ChapterWorkspaceTabs", () => {
  it("shows stable work areas and reports tab changes", () => {
    const onChange = vi.fn();
    render(<ChapterWorkspaceTabs value="plan" onChange={onChange} />);

    expect(screen.getByRole("tab", { name: "章节执行卡" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "章节执行卡" })).toHaveAttribute("aria-controls", "chapter-panel-plan");
    expect(screen.getByRole("tab", { name: "创作准备" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "创作准入" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "修订与冲突" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "恢复草稿" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "AI 创作" }));
    expect(onChange).toHaveBeenCalledWith("ai");
  });
});
