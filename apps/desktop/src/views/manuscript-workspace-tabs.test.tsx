import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManuscriptWorkspaceTabs } from "./manuscript-workspace-tabs";

describe("ManuscriptWorkspaceTabs", () => {
  it("groups manuscript actions in writing order", () => {
    const onChange = vi.fn();
    render(<ManuscriptWorkspaceTabs value="editor" onChange={onChange} recoveryCount={2} />);

    expect(screen.getByRole("tab", { name: "正文编辑" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "正文审核" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "草稿与版本" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "知识提取" })).toBeVisible();
    expect(screen.getByLabelText("2 次自动保护待处理")).toHaveTextContent("待处理");
    fireEvent.click(screen.getByRole("tab", { name: "知识提取" }));
    expect(onChange).toHaveBeenCalledWith("extraction");
  });
});
