import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StoryPlanningWorkbench } from "./story-planning-workbench";
import { emptyPlanningSection } from "./use-planning-draft";

const mocks = vi.hoisted(() => ({ listPlanningSections: vi.fn(), savePlanningSection: vi.fn(), listModelProfiles: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks }));
vi.mock("../lib/jobs-query", () => ({ useJobs: () => ({ data: [] }) }));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {} }),
}));
vi.mock("./planning-discussion-sources", () => ({ PlanningDiscussionSources: () => null }));
const stored = { ...emptyPlanningSection("seed-premise"), version: 4, content: "已有正式内容" };
function setup() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StoryPlanningWorkbench selectedSectionId="seed-premise" /></QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listModelProfiles.mockResolvedValue([]);
  mocks.listPlanningSections.mockResolvedValue([stored]);
  mocks.savePlanningSection.mockImplementation((section) => Promise.resolve({ ...section, version: 5 }));
});
afterEach(cleanup);
describe("planning content editor", () => {
  it("saves book preferences directly with version checks and retains old candidates", async () => {
    const preferences = {
      ...emptyPlanningSection("seed-tone"), version: 7, storyState: "LOCKED" as const,
      content: "原篇幅和基调", pendingContent: "旧候选仍保留",
    };
    mocks.listPlanningSections.mockResolvedValue([preferences]);
    render(<QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-tone" /></QueryClientProvider>);
    const editor = await screen.findByLabelText("篇幅、风格与边界");
    await waitFor(() => expect(editor).toBeEnabled());
    expect(editor).not.toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "约 20 万字，轻松，第三人称。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存笔记" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-tone", content: "约 20 万字，轻松，第三人称。", pendingContent: "旧候选仍保留",
      version: 7, storyState: "LOCKED",
    })));
    expect(screen.getByLabelText("笔记状态")).not.toBeVisible();
  });

  it("does not replace book preference edits when a checked save fails", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.savePlanningSection.mockRejectedValue(new Error("版本冲突"));
    render(<QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-tone" /></QueryClientProvider>);
    const editor = await screen.findByLabelText("篇幅、风格与边界");
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "先写短篇，结局未定。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存笔记" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(editor).toHaveValue("先写短篇，结局未定。");
  });

  it("does not turn an author-reserved note into a formal setting on ordinary save", async () => {
    mocks.listPlanningSections.mockResolvedValue([{
      ...emptyPlanningSection("seed-tone"), content: "作者尚未公开的偏好", storyState: "AUTHOR_RESERVED", version: 6,
    }]);
    render(<QueryClientProvider client={new QueryClient()}>
      <StoryPlanningWorkbench selectedSectionId="seed-tone" /></QueryClientProvider>);
    const editor = await screen.findByLabelText("篇幅、风格与边界");
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "修改私有偏好，仍不公开。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存笔记" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      storyState: "AUTHOR_RESERVED", content: "修改私有偏好，仍不公开。", version: 6,
    })));
  });

  it("uses one save area for draft content and author state with the original version", async () => {
    setup();
    expect(await screen.findByRole("textbox", { name: "正式规划" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存状态" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑内容" }));
    fireEvent.change(screen.getByRole("textbox", { name: "规划草稿" }), { target: { value: "新的作者草稿" } });
    fireEvent.change(screen.getByLabelText("内容状态"), { target: { value: "AUTHOR_RESERVED" } });
    fireEvent.click(screen.getByRole("button", { name: "正式内容" }));
    fireEvent.click(screen.getByRole("button", { name: "草稿与候选" }));
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue("新的作者草稿");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      content: "已有正式内容", pendingContent: "新的作者草稿", storyState: "AUTHOR_RESERVED", version: 4,
    })));
  });
  it("allows an empty item to be authored without a model, preserving failed edits", async () => {
    mocks.listPlanningSections.mockResolvedValue([]);
    mocks.savePlanningSection.mockRejectedValue(new Error("版本冲突"));
    setup();
    await screen.findByRole("textbox", { name: "正式规划" });
    fireEvent.click(screen.getByRole("button", { name: "编辑内容" }));
    fireEvent.change(screen.getByRole("textbox", { name: "规划草稿" }), { target: { value: "第一版构想" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
    expect(screen.getByRole("textbox", { name: "规划草稿" })).toHaveValue("第一版构想");
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({ version: 0, pendingContent: "第一版构想" }));
  });
});
