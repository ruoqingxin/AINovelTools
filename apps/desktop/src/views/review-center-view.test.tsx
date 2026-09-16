import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCenterView } from "./review-center-view";

const mocks = vi.hoisted(() => ({
  currentManuscript: vi.fn(),
  getAuditFlowSettings: vi.fn(),
  listPlanNodes: vi.fn(),
  listPlanningSections: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    currentManuscript: mocks.currentManuscript,
    getAuditFlowSettings: mocks.getAuditFlowSettings,
    listPlanNodes: mocks.listPlanNodes,
    listPlanningSections: mocks.listPlanningSections,
  };
});

vi.mock("./knowledge-review-view", () => ({
  KnowledgeReviewView: (props: { embedded?: boolean; chapterId?: string }) => (
    <div data-testid="facts-review" data-chapter={props.chapterId} data-embedded={String(props.embedded)} />
  ),
}));

vi.mock("./ai-writing-panel", () => ({
  AiWritingPanel: (props: {
    reviewPurpose?: string;
    chapterId: string;
    chapterPlan: string;
    volumePlan: string;
    draft: string;
  }) => (
    <div
      data-testid="consistency-review"
      data-purpose={props.reviewPurpose}
      data-plan={props.chapterPlan}
      data-volume-plan={props.volumePlan}
      data-draft={props.draft}
    >
      {props.chapterId}
    </div>
  ),
}));

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ReviewCenterView /></QueryClientProvider>);
}

describe("ReviewCenterView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/review");
    mocks.listPlanNodes.mockResolvedValue([
      { id: "volume-1", parentId: null, kind: "VOLUME", title: "第一卷", sortOrder: 1, archived: false, revision: 1 },
      { id: "chapter-1", parentId: "volume-1", kind: "CHAPTER", title: "第1章", sortOrder: 1, archived: false, revision: 1 },
      { id: "chapter-2", parentId: "volume-1", kind: "CHAPTER", title: "第2章", sortOrder: 2, archived: false, revision: 1 },
    ]);
    mocks.listPlanningSections.mockResolvedValue([
      { id: "plan-node:chapter-1", content: "第一章执行卡", pendingContent: "", storyState: "CONFIRMED", rationale: "", consequence: "", references: [], updatedAt: "" },
      { id: "plan-node:chapter-2", content: "第二章执行卡", pendingContent: "", storyState: "CONFIRMED", rationale: "", consequence: "", references: [], updatedAt: "" },
      { id: "plan-node:volume-1", content: "第一卷规划", pendingContent: "", storyState: "CONFIRMED", rationale: "", consequence: "", references: [], updatedAt: "" },
    ]);
    mocks.currentManuscript.mockResolvedValue({ id: "revision-1", documentJson: "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"正式正文\"}]}]}" });
    mocks.getAuditFlowSettings.mockResolvedValue({ admission: true, manuscript: true, knowledge: true });
  });

  afterEach(() => cleanup());

  it("switches audit purposes and keeps the selected chapter context", async () => {
    renderView();

    const admission = await screen.findByTestId("consistency-review");
    expect(admission).toHaveAttribute("data-purpose", "admission");
    expect(admission).toHaveAttribute("data-plan", "第一章执行卡");
    expect(admission).toHaveAttribute("data-volume-plan", "第一卷规划");
    await waitFor(() => expect(admission).toHaveAttribute("data-draft", expect.stringContaining("正式正文")));

    fireEvent.change(screen.getByLabelText("章节"), { target: { value: "chapter-2" } });
    await waitFor(() => expect(screen.getByTestId("consistency-review")).toHaveTextContent("chapter-2"));
    expect(screen.getByTestId("consistency-review")).toHaveAttribute("data-plan", "第二章执行卡");

    fireEvent.click(screen.getByRole("tab", { name: "正文审核" }));
    expect(await screen.findByTestId("consistency-review")).toHaveAttribute("data-purpose", "manuscript");

    fireEvent.click(screen.getByRole("tab", { name: "知识审核" }));
    expect(await screen.findByTestId("facts-review")).toHaveAttribute("data-chapter", "chapter-2");
  });
});
