import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedAiWorkspace } from "./unified-ai-workspace";
import { useInAiWorkspace } from "./content-identity";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks }));
function Task({ name }: { name: string }) { return <p>{name} · {useInAiWorkspace() ? "统一处理" : "展示"}</p>; }
vi.mock("./coauthor-view", () => ({ CoauthorView: () => <Task name="自由工作稿" /> }));
vi.mock("./creation-preparation-view", () => ({ CreationPreparationView: () => <Task name="创作准备" /> }));
vi.mock("./story-planning-workbench", () => ({ StoryPlanningWorkbench: () => <Task name="准备节点" /> }));
vi.mock("./project-workspace-view", () => ({ ProjectWorkspaceView: ({ mode }: { mode?: string }) => <Task name={mode === "writing" ? "正文处理" : "大纲处理"} /> }));
vi.mock("./story-bible-view", () => ({ StoryBibleView: () => <Task name="设定处理" /> }));
vi.mock("./materials-view", () => ({ MaterialsView: () => <Task name="参考处理" /> }));
vi.mock("./knowledge-records-view", () => ({ KnowledgeRecordsView: () => <Task name="剧情记录处理" /> }));
vi.mock("./review-center-view", () => ({ ReviewCenterView: () => <Task name="核对处理" /> }));

beforeEach(() => { mocks.getCurrentProject.mockResolvedValue({ projectId: "p", name: "雾城" }); });
afterEach(cleanup);
function setup(search = "") {
  window.history.replaceState(null, "", `/discussion${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UnifiedAiWorkspace /></QueryClientProvider>);
  return client;
}
describe("unified AI workspace", () => {
  it("does not mount any editor without an open project", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    setup();
    expect(await screen.findByText("请先打开作品。")).toBeVisible();
    expect(screen.queryByText(/ · 统一处理$/)).not.toBeInTheDocument();
  });
  it("retains the discussion entry and offers the same content categories", async () => {
    setup();
    expect(await screen.findByText("自由工作稿 · 统一处理")).toBeVisible();
    for (const label of ["设定", "大纲与准备", "正文", "剧情记录", "辅助参考"]) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", expect.stringContaining("/discussion?work="));
    }
  });
  it.each([
    ["entity", "设定处理"], ["planning", "大纲处理"], ["writing", "正文处理"],
    ["records", "剧情记录处理"], ["materials", "参考处理"], ["preparation", "创作准备"], ["section", "准备节点"],
  ])("opens %s only inside the project-scoped AI workspace", async (work, text) => {
    setup(`?work=${work}&targetProject=p`);
    expect(await screen.findByText(`${text} · 统一处理`)).toBeVisible();
    expect(screen.queryByText("自由工作稿 · 统一处理")).not.toBeInTheDocument();
  });
  it.each(["?work=writing&targetProject=other", "?work=entity", "?work=unknown&targetProject=p"])(
    "does not fall back to another editor for %s", async (search) => {
      setup(search);
      expect(await screen.findByRole("alert")).toHaveTextContent("未打开其他对象");
      expect(screen.queryByText(/ · 统一处理$/)).not.toBeInTheDocument();
    });
  it("unmounts the target editor when the project changes", async () => {
    const client = setup("?work=writing&targetProject=p&planNode=chapter");
    await screen.findByText("正文处理 · 统一处理");
    act(() => client.setQueryData(["current-project"], { projectId: "other" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不属于当前作品");
    expect(screen.queryByText("正文处理 · 统一处理")).not.toBeInTheDocument();
  });
  it("identifies a chapter plan as outline rather than manuscript work", async () => {
    setup("?work=writing&targetProject=p&planNode=chapter&tab=plan");
    expect(await screen.findByRole("heading", { name: "大纲 · 章节细纲" })).toBeVisible();
    expect(screen.getByRole("link", { name: "大纲与准备" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "正文" })).not.toHaveAttribute("aria-current");
  });
});
