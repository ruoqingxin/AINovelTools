import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManuscriptSourceView } from "./manuscript-source-view";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn(), getManuscriptSource: vi.fn(),
  saveManuscript: vi.fn(), currentManuscriptDraft: vi.fn(), saveRecoveryLog: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
const documentJson = JSON.stringify({ type: "doc", content: [{ type: "blockquote", attrs: { blockId: "outer" },
  content: [{ type: "paragraph", attrs: { blockId: 'block:1"]' },
    content: [{ type: "text", text: "原修订的嵌套正文" }] }] }] });
const source = { revision: { id: "old-revision", chapterId: "chapter-1", documentJson, createdAt: "2026-10-09T00:00:00Z" },
  chapterTitle: "原章节", chapterArchived: false, isCurrentRevision: false, blockId: 'block:1"]', quote: "嵌套正文" };

function renderSource(search = "?sourceProject=project-1&sourceRevision=old-revision&returnTo=%2Fsearch%3Fq%3Dold") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ManuscriptSourceView search={search} />
  </QueryClientProvider>);
}

describe("verified read-only source view", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.getManuscriptSource.mockResolvedValue(source);
  });

  it("renders the bound historical revision and focuses a nested opaque block without touching drafts", async () => {
    renderSource();
    expect(await screen.findByRole("heading", { name: "原章节" })).toBeVisible();
    expect(screen.getByText(/历史修订/)).toBeVisible();
    const reader = await screen.findByLabelText("来源正文");
    const target = reader.querySelector("[data-source-target=true]")!;
    expect(target).toHaveAttribute("data-block-id", 'block:1"]');
    expect(target).toHaveTextContent("原修订的嵌套正文");
    await waitFor(() => expect(target).toHaveFocus());
    expect(reader).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("link", { name: "返回来源" })).toHaveAttribute("href", "/search?q=old");
    expect(mocks.getManuscriptSource).toHaveBeenCalledWith({ projectId: "project-1", revisionId: "old-revision" });
    expect(mocks.saveManuscript).not.toHaveBeenCalled();
    expect(mocks.currentManuscriptDraft).not.toHaveBeenCalled();
    expect(mocks.saveRecoveryLog).not.toHaveBeenCalled();
  });

  it("shows source mismatch explicitly, hides text, and retries only the same source", async () => {
    mocks.getManuscriptSource.mockRejectedValueOnce({ code: "SOURCE_MISMATCH", message: "来源不匹配" });
    renderSource();
    expect(await screen.findByRole("alert")).toHaveTextContent("未切换到其他修订");
    expect(screen.queryByLabelText("来源正文")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试定位" }));
    expect(await screen.findByRole("heading", { name: "原章节" })).toBeVisible();
    expect(mocks.getManuscriptSource.mock.calls[0]).toEqual(mocks.getManuscriptSource.mock.calls[1]);
  });

  it("does not offer archived chapter editing", async () => {
    mocks.getManuscriptSource.mockResolvedValue({ ...source, chapterArchived: true });
    renderSource();
    expect(await screen.findByText(/章节已归档/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "进入本章" })).not.toBeInTheDocument();
  });

  it("reports an unopened project without invoking manuscript lookup", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    renderSource();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开来源项目");
    expect(mocks.getManuscriptSource).not.toHaveBeenCalled();
  });

  it("shows loading until source verification completes", async () => {
    mocks.getManuscriptSource.mockReturnValue(new Promise(() => {}));
    renderSource();
    expect(await screen.findByRole("status")).toHaveTextContent("正在校验正文来源");
    expect(screen.queryByLabelText("来源正文")).not.toBeInTheDocument();
  });
});
