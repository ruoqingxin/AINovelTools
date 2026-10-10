import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanNode } from "../lib/tauri-client";
import { ProjectWorkspaceView } from "./project-workspace-view";

const mocks = vi.hoisted(() => ({
  listPlanNodes: vi.fn(), getCurrentProject: vi.fn(), listPlanningSections: vi.fn(), listModelProfiles: vi.fn(),
  getAuditFlowSettings: vi.fn(), savePlanningSection: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("../lib/jobs-query", () => ({ useJobs: () => ({ data: [] }) }));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {} }),
}));
vi.mock("./use-chapter-manuscript", () => ({
  useChapterManuscript: () => ({ manuscript: {}, chapterDirty: false, savingDraft: false, draftNeedsPersistence: false, setManuscriptTab: vi.fn() }),
}));
vi.mock("./planning-discussion-sources", () => ({ PlanningDiscussionSources: () => null }));

const scene: PlanNode = { id: "scene-1", kind: "SCENE", parentId: null, title: "重逢", archived: false, revision: 1, sortOrder: 0 };
function renderPlan(search = "?planNode=scene-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D重逢%26type%3DPLAN") {
  window.history.replaceState(null, "", `/planning${search}`);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectWorkspaceView /></QueryClientProvider>);
}

describe("exact planning navigation", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.listPlanNodes.mockResolvedValue([scene]);
    mocks.listPlanningSections.mockResolvedValue([{
      id: "plan-node:scene-1", content: "场景的正式计划", pendingContent: "", storyState: "CONFIRMED",
      rationale: "", consequence: "", references: [], updatedAt: "", version: 1,
    }]);
    mocks.listModelProfiles.mockResolvedValue([]);
    mocks.getAuditFlowSettings.mockResolvedValue({ admission: true, manuscript: true, knowledge: true });
  });

  it("opens the exact current node in the existing editor with a search return", async () => {
    renderPlan();
    expect(await screen.findByDisplayValue("场景的正式计划")).toBeVisible();
    const back = new URL(screen.getByRole("link", { name: "返回来源" }).getAttribute("href")!, window.location.origin);
    expect(back.searchParams.get("q")).toBe("重逢");
    expect(back.searchParams.get("type")).toBe("PLAN");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it.each([
    "?planNode=missing&targetProject=project-1", "?planNode=scene-1&targetProject=foreign",
    "?planNode=scene-1", "?planNode=&targetProject=project-1",
    "?planNode=scene-1&targetProject=project-1&discussionTarget=plan-node:scene-1",
  ])("rejects unavailable or ambiguous targets without opening another plan: %s", async (search) => {
    renderPlan(search);
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他规划项");
    expect(screen.queryByDisplayValue("场景的正式计划")).not.toBeInTheDocument();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("does not open an archived node", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, archived: true }]);
    renderPlan();
    expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他规划项");
    expect(screen.queryByDisplayValue("场景的正式计划")).not.toBeInTheDocument();
  });

  it("retries a failed project check without falling back to another node", async () => {
    mocks.getCurrentProject.mockRejectedValueOnce(new Error("读取项目失败"));
    renderPlan();
    expect(await screen.findByRole("alert")).toHaveTextContent("无法核对目标项目");
    expect(screen.queryByDisplayValue("场景的正式计划")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试定位" }));
    expect(await screen.findByDisplayValue("场景的正式计划")).toBeVisible();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps planning admission intact for an exact outline link", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "outline-1", kind: "OUTLINE", title: "大纲" }]);
    renderPlan("?planNode=outline-1&targetProject=project-1");
    expect(await screen.findByText("故事大纲尚未开放")).toBeVisible();
    expect(screen.queryByRole("button", { name: "保存规划" })).not.toBeInTheDocument();
  });

  it("keeps dirty plan edits when returning to the same target after a cancelled node switch", async () => {
    mocks.listPlanNodes.mockResolvedValue([scene, { ...scene, id: "scene-2", title: "离别" }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPlan();
    const input = await screen.findByDisplayValue("场景的正式计划");
    await act(async () => {});
    fireEvent.change(input, { target: { value: "作者尚未保存的计划" } });
    await waitFor(() => expect(input).toHaveValue("作者尚未保存的计划"));
    fireEvent.click(screen.getByRole("button", { name: /离别/ }));
    expect(confirm).toHaveBeenCalled();
    expect(input).toHaveValue("作者尚未保存的计划");
  });

  it("links a chapter result to its current plan assistant and preserves the return", async () => {
    mocks.listPlanNodes.mockResolvedValue([{ ...scene, id: "chapter-1", kind: "CHAPTER", title: "入城" }]);
    renderPlan("?planNode=chapter-1&targetProject=project-1&returnTo=%2Fsearch%3Fq%3D入城%26type%3DPLAN");
    const url = new URL((await screen.findByRole("link", { name: "查看本章计划" })).getAttribute("href")!, window.location.origin);
    expect(url.pathname).toBe("/writing");
    expect(url.searchParams.get("planNode")).toBe("chapter-1");
    expect(url.searchParams.get("assistant")).toBe("plan");
    const back = new URL(url.searchParams.get("returnTo")!, window.location.origin);
    expect(back.searchParams.get("q")).toBe("入城");
    expect(back.searchParams.get("type")).toBe("PLAN");
  });
});
