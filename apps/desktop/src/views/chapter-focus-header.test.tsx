import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ChapterFocusHeader } from "./chapter-focus-header";
import { AiWorkspaceContext } from "./content-identity";

afterEach(cleanup);
function props(): ComponentProps<typeof ChapterFocusHeader> {
  const selected = { id: "chapter", kind: "CHAPTER" as const, title: "入城", parentId: null, sortOrder: 0, revision: 1, archived: false };
  return {
    selected, chapterNodes: [selected], selectedChapterIndex: 0, selectedVolume: undefined,
    previousChapter: null, nextChapter: null, editTitle: selected.title, moveCandidates: [], moveParentId: "",
    canMoveToRoot: true, workspaceMode: "writing",
    onDelete: vi.fn(), onEditTitleChange: vi.fn(), onMove: vi.fn(), onMoveParentChange: vi.fn(),
    onCreateScene: vi.fn(), onSave: vi.fn(), onSelectNode: vi.fn(), onToggleArchived: vi.fn(),
  };
}

it("keeps chapter navigation but no structural editing on the ordinary manuscript page", () => {
  render(<ChapterFocusHeader {...props()} />);
  expect(screen.getByRole("heading", { name: "入城" })).toBeVisible();
  expect(screen.getByRole("button", { name: "上一章" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下一章" })).toBeDisabled();
  expect(screen.queryByLabelText("章节设置")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("编辑节点标题")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
});

it("retains chapter settings in the unified AI workspace", () => {
  const options = props();
  render(<AiWorkspaceContext.Provider value><ChapterFocusHeader {...options} /></AiWorkspaceContext.Provider>);
  fireEvent.click(screen.getByLabelText("章节设置"));
  expect(screen.getByLabelText("编辑节点标题")).toHaveValue("入城");
  fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
  expect(options.onSave).toHaveBeenCalledOnce();
});
