import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManuscriptExportPanel } from "./manuscript-export-panel";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";

const mocks = vi.hoisted(() => ({ exportManuscript: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));

const receipt = {
  projectId: "project-1", scope: { kind: "BOOK" }, format: "TXT",
  path: "E:\\Novel\\exports\\manuscript-1\\manuscript.txt",
  chapters: [{ chapterId: "chapter-1", revisionId: "revision-1", title: "入城" }],
  skippedChapters: [], draftChapterCount: 0,
};
const props = { projectId: "project-1", chapter: { id: "chapter-1", title: "入城" }, chapterDirty: false, saving: false };
function openPanel() { fireEvent.click(screen.getByText("导出正文")); }
function deferred() {
  let resolve!: (value: typeof receipt) => void;
  const promise = new Promise<typeof receipt>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ManuscriptExportPanel", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.exportManuscript.mockResolvedValue(receipt); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("does not read or export while closed and offers only book scope without a chapter", () => {
    render(<ManuscriptExportPanel {...props} chapter={undefined} />);
    expect(mocks.exportManuscript).not.toHaveBeenCalled();
    openPanel();
    expect(screen.getByLabelText("导出范围")).toHaveValue("book");
    expect(screen.queryByRole("option", { name: /当前章节/ })).not.toBeInTheDocument();
    expect(mocks.exportManuscript).not.toHaveBeenCalled();
  });

  it("captures explicit project/chapter/format without sending editor contents", async () => {
    render(<ManuscriptExportPanel {...props} />);
    openPanel();
    fireEvent.change(screen.getByLabelText("文件格式"), { target: { value: "MARKDOWN" } });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("status");
    expect(mocks.exportManuscript).toHaveBeenCalledExactlyOnceWith({
      expectedProjectId: "project-1", format: "MARKDOWN", scope: { kind: "CHAPTER", chapterId: "chapter-1" },
    });
    expect(screen.getByText(receipt.path)).toBeVisible();
  });

  it("exports all saved chapters and reports omitted drafts and missing revisions", async () => {
    mocks.exportManuscript.mockResolvedValue({ ...receipt, draftChapterCount: 2,
      skippedChapters: [{ chapterId: "empty", title: "尚未写正文" }] });
    render(<ManuscriptExportPanel {...props} />);
    openPanel();
    fireEvent.change(screen.getByLabelText("导出范围"), { target: { value: "book" } });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("status");
    expect(mocks.exportManuscript).toHaveBeenCalledWith({
      expectedProjectId: "project-1", format: "TXT", scope: { kind: "BOOK" },
    });
    expect(screen.getByText("另有 2 章本地草稿未导出")).toBeVisible();
    fireEvent.click(screen.getByText("1 章尚无已保存正文"));
    expect(screen.getByText("尚未写正文")).toBeVisible();
  });

  it("confirms saved-only export when the current editor is dirty and preserves cancellation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ManuscriptExportPanel {...props} chapterDirty />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("只导出已保存正文"));
    expect(mocks.exportManuscript).not.toHaveBeenCalled();
    await act(async () => {});
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("status");
    expect(mocks.exportManuscript).toHaveBeenCalledOnce();
  });

  it("locks fields and rejects duplicate submissions while exporting", async () => {
    const pending = deferred();
    mocks.exportManuscript.mockReturnValue(pending.promise);
    render(<ManuscriptExportPanel {...props} />);
    openPanel();
    const button = screen.getByRole("button", { name: "导出" });
    fireEvent.click(button);
    expect(screen.getByLabelText("导出范围")).toBeDisabled();
    expect(screen.getByLabelText("文件格式")).toBeDisabled();
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    expect(mocks.exportManuscript).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(receipt); });
    expect(screen.getByLabelText("文件格式")).toBeEnabled();
  });

  it("keeps selected options and allows retry after write or target failure", async () => {
    mocks.exportManuscript.mockRejectedValueOnce({ code: "FILE_SYSTEM_ERROR", message: "磁盘写入失败" });
    render(<ManuscriptExportPanel {...props} />);
    openPanel();
    fireEvent.change(screen.getByLabelText("文件格式"), { target: { value: "MARKDOWN" } });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘写入失败");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("文件格式")).toHaveValue("MARKDOWN");
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.exportManuscript).toHaveBeenCalledTimes(2);
  });

  it("does not attach a late receipt to a newly selected project or chapter", async () => {
    const pending = deferred();
    mocks.exportManuscript.mockReturnValue(pending.promise);
    const view = render(<ManuscriptExportPanel key="project-1:chapter-1" {...props} />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    view.rerender(<ManuscriptExportPanel key="project-2:chapter-2" {...props}
      projectId="project-2" chapter={{ id: "chapter-2", title: "北境" }} />);
    await act(async () => { pending.resolve(receipt); });
    openPanel();
    expect(screen.queryByText(receipt.path)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("导出范围")).toHaveValue("chapter");
  });

  it("cannot export while formal manuscript saving is still in progress", async () => {
    render(<ManuscriptExportPanel {...props} saving />);
    openPanel();
    const button = screen.getByRole("button", { name: "导出" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    await waitFor(() => expect(mocks.exportManuscript).not.toHaveBeenCalled());
  });

  it("uses the shared confirmation and cancels without exporting or losing selected options", async () => {
    render(<ConfirmActionProvider><ManuscriptExportPanel {...props} chapterDirty /></ConfirmActionProvider>);
    openPanel();
    fireEvent.change(screen.getByLabelText("文件格式"), { target: { value: "MARKDOWN" } });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    expect(mocks.exportManuscript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.getByLabelText("文件格式")).toBeEnabled());
    expect(screen.getByLabelText("文件格式")).toHaveValue("MARKDOWN");
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(screen.getByRole("button", { name: "导出已保存正文" }));
    await screen.findByRole("status");
    expect(mocks.exportManuscript).toHaveBeenCalledOnce();
  });

  it("does not export a stale project after confirmation", async () => {
    const view = render(<ConfirmActionProvider><ManuscriptExportPanel {...props} chapterDirty /></ConfirmActionProvider>);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    view.rerender(<ConfirmActionProvider><ManuscriptExportPanel {...props} projectId="project-2" chapterDirty /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "导出已保存正文" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导出" })).toBeEnabled());
    expect(mocks.exportManuscript).not.toHaveBeenCalled();
  });
});
