import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionSourceView } from "./discussion-source-view";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn(), getDiscussionSource: vi.fn(),
  listDiscussionMessages: vi.fn(), createDiscussionSession: vi.fn(), saveDiscussionWorkspace: vi.fn(),
  promoteDiscussionCandidate: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
const source = {
  session: { id: "old-session", projectId: "project-1", title: "原始讨论" },
  message: { id: "old-message", role: "ASSISTANT", content: "最近一百条之外的原始消息。" },
  candidate: { id: "candidate-1", sessionId: "old-session", messageId: "old-message", kind: "PLANNING",
    content: "作者修改后的候选。", targetSectionId: "plan-node:chapter-1",
    promotedObjectId: "plan-node:chapter-1", status: "PROMOTED" },
  planningTargetAvailable: true, planningTargetKind: "CHAPTER",
};
function renderSource(search = "?sourceCandidate=candidate-1&sourceSession=old-session&sourceSection=plan-node%3Achapter-1&returnTo=%2Fplanning%23chapter-1") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DiscussionSourceView search={search} />
  </QueryClientProvider>);
}

describe("verified discussion source", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.getDiscussionSource.mockResolvedValue(source);
  });
  it("reads the exact old message and distinct candidate without loading a mutable discussion", async () => {
    renderSource();
    expect(await screen.findByLabelText("原始讨论消息")).toHaveTextContent(source.message.content);
    expect(screen.getByLabelText("候选快照")).toHaveTextContent(source.candidate.content);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回来源" })).toHaveAttribute("href", "/planning#chapter-1");
    expect(screen.getByRole("link", { name: "进入讨论" })).toHaveAttribute("href", "/discussion#old-session");
    const link = new URL(screen.getByRole("link", { name: "打开规划待定区" }).getAttribute("href")!, window.location.origin);
    expect(link.pathname).toBe("/writing");
    expect(link.searchParams.get("assistant")).toBe("plan");
    expect(link.searchParams.get("targetProject")).toBe("project-1");
    expect(mocks.getDiscussionSource).toHaveBeenCalledWith({ candidateId: "candidate-1", sessionId: "old-session",
      sectionId: "plan-node:chapter-1", projectId: "project-1" });
    expect(mocks.listDiscussionMessages).not.toHaveBeenCalled();
    expect(mocks.createDiscussionSession).not.toHaveBeenCalled();
    expect(mocks.saveDiscussionWorkspace).not.toHaveBeenCalled();
    expect(mocks.promoteDiscussionCandidate).not.toHaveBeenCalled();
  });
  it("reports mismatched sources without fallback and retries the same request", async () => {
    mocks.getDiscussionSource.mockRejectedValueOnce(new Error("来源不匹配"));
    renderSource();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他讨论");
    expect(screen.queryByLabelText("原始讨论消息")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入讨论" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试定位" }));
    expect(await screen.findByLabelText("原始讨论消息")).toBeVisible();
    expect(mocks.getDiscussionSource.mock.calls[0]).toEqual(mocks.getDiscussionSource.mock.calls[1]);
  });
  it("keeps missing candidate IDs in an explicit error state and rejects external return links", async () => {
    renderSource("?sourceCandidate=&returnTo=https%3A%2F%2Foutside.test");
    expect(await screen.findByRole("alert")).toHaveTextContent("未指定来源候选");
    expect(mocks.getDiscussionSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "返回来源" })).not.toBeInTheDocument();
  });
  it("retains historical text when the transferred planning target is archived", async () => {
    mocks.getDiscussionSource.mockResolvedValue({ ...source, planningTargetAvailable: false });
    renderSource();
    expect(await screen.findByText("目标规划已不可用")).toBeVisible();
    expect(screen.getByLabelText("原始讨论消息")).toHaveTextContent(source.message.content);
    expect(screen.queryByRole("link", { name: "打开规划待定区" })).not.toBeInTheDocument();
  });
  it("does not query a source without an open project", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    renderSource();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开来源项目");
    expect(mocks.getDiscussionSource).not.toHaveBeenCalled();
  });
  it("shows verification pending without displaying unverified text", async () => {
    mocks.getDiscussionSource.mockReturnValue(new Promise(() => {}));
    renderSource();
    expect(await screen.findByRole("status")).toHaveTextContent("正在校验讨论来源");
    expect(screen.queryByLabelText("原始讨论消息")).not.toBeInTheDocument();
  });
});
