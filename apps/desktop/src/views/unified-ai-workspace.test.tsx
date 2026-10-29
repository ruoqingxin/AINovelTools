import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedAiWorkspace } from "./unified-ai-workspace";
import { useInAiWorkspace } from "./content-identity";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks }));
function Task({ name }: { name: string }) { return <p>{name} · {useInAiWorkspace() ? "统一处理" : "展示"}</p>; }
vi.mock("./coauthor-view", () => ({ CoauthorView: () => <Task name="自由工作稿" /> }));
vi.mock("./creation-preparation-view", () => ({ CreationPreparationView: () => <Task name="筹备" /> }));
vi.mock("./book-preparation-view", () => ({ BookPreparationView: () => <Task name="全书方向" /> }));
vi.mock("./story-planning-workbench", async () => ({
  ...await vi.importActual<typeof import("./story-planning-workbench")>("./story-planning-workbench"),
  StoryPlanningWorkbench: () => <Task name="准备节点" />,
}));
vi.mock("./project-workspace-view", () => ({ ProjectWorkspaceView: ({ mode, chapterPlanTask }: { mode?: string; chapterPlanTask?: boolean }) => <Task name={chapterPlanTask ? "章节细纲处理" : mode === "writing" ? "正文处理" : "大纲处理"} /> }));
vi.mock("./story-bible-view", () => ({ StoryBibleView: () => <Task name="设定处理" /> }));
vi.mock("./materials-view", () => ({ MaterialsView: () => <Task name="参考处理" /> }));
vi.mock("./knowledge-records-view", () => ({ KnowledgeRecordsView: () => <Task name="剧情记录处理" /> }));
vi.mock("./review-center-view", () => ({ ReviewCenterView: () => <Task name="核对处理" /> }));

beforeEach(() => { mocks.getCurrentProject.mockResolvedValue({ projectId: "p", name: "雾城" }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(search = "") {
  window.history.replaceState(null, "", `/discussion${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UnifiedAiWorkspace /></QueryClientProvider>);
  return client;
}
describe("unified AI workspace", () => {
  it("uses the router destination even before browser history finishes a confirmed transition", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/discussion?work=section&targetProject=p&item=seed-tone");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute();
    const route = createRoute({ getParentRoute: () => root, path: "/discussion", component: UnifiedAiWorkspace });
    const router = createRouter({ routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/discussion?work=planning&targetProject=p&planNode=manager"] }) });
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    expect(await screen.findByText("大纲处理 · 统一处理")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "筹备内容" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "大纲" })).toHaveAttribute("aria-current", "page");
  });
  it("does not mount any editor without an open project", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    setup();
    expect(await screen.findByText("请先打开作品。")).toBeVisible();
    expect(screen.queryByText(/ · 统一处理$/)).not.toBeInTheDocument();
  });
  it("retains the discussion entry and offers the same content categories", async () => {
    setup();
    expect(await screen.findByText("自由工作稿 · 统一处理")).toBeVisible();
    expect(screen.getByRole("heading", { name: "共创", level: 1 })).toBeVisible();
    expect(screen.getByRole("link", { name: "自由讨论" })).toHaveAttribute("aria-current", "page");
    for (const label of ["设定", "大纲", "正文", "剧情记录", "辅助参考"]) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", expect.stringContaining("/discussion?work="));
    }
  });
  it.each([
    ["entity", "设定处理"], ["planning", "大纲处理"], ["writing", "正文处理"],
    ["records", "剧情记录处理"], ["materials", "参考处理"], ["preparation", "全书方向"], ["section", "准备节点"],
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
      expect(screen.getByRole("navigation", { name: "AI 内容分类" }).querySelectorAll('a[aria-current="page"]')).toHaveLength(0);
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
    expect(await screen.findByText("章节细纲处理 · 统一处理")).toBeVisible();
    expect(screen.queryByText("正文处理 · 统一处理")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "大纲" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "正文" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "返回大纲 · 章节细纲" })).toHaveAttribute("href",
      "/planning?targetProject=p&planNode=chapter&mode=structure");
  });
  it("opens book preferences inside coauthor without a duplicate identity block", async () => {
    setup("?work=preparation&targetProject=p");
    await screen.findByText("全书方向 · 统一处理");
    expect(within(screen.getByRole("navigation", { name: "AI 内容分类" })).getAllByRole("link")[0]).toHaveTextContent("自由讨论");
    expect(screen.getByRole("link", { name: "筹备" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "大纲" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByText("内容归属")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "本书偏好" })).toHaveAttribute("href", "/discussion?work=preparation&targetProject=p");
  });
  it.each([
    ["?work=preparation&targetProject=p&item=protagonist", "筹备"],
    ["?work=section&targetProject=p&item=seed-hook", "筹备"],
    ["?work=planning&targetProject=p&planNode=volume", "大纲"],
    ["?work=writing&targetProject=p&planNode=chapter", "正文"],
    ["?work=writing&targetProject=p&planNode=chapter&tab=plan", "大纲"],
    ["?work=entity&targetProject=p&entity=person", "设定"],
    ["?work=records&targetProject=p&tab=events&objectId=event", "剧情记录"],
    ["?work=materials&targetProject=p&summary=memory&materialKind=SUMMARY", "辅助参考"],
    ["?work=review&targetProject=p&objectId=todo", "待办核对"],
    ["?targetProject=p&targetSession=session#message", "自由讨论"],
  ])("preserves the exact target when the active %s category is clicked", async (search, label) => {
    setup(search);
    await screen.findByText(/ · 统一处理$/);
    const nav = screen.getByRole("navigation", { name: "AI 内容分类" });
    expect(nav.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: label })).toHaveAttribute("href", `/discussion${search}`);
  });
  it("retains exact links to the existing story preparation tasks", async () => {
    setup("?work=preparation&targetProject=p&item=premise");
    expect(await screen.findByText("筹备 · 统一处理")).toBeVisible();
    expect(screen.queryByText("全书方向 · 统一处理")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "故事准备" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "故事准备" })).toHaveAttribute("href",
      "/discussion?work=preparation&targetProject=p&item=premise");
    expect(screen.getByRole("link", { name: "补充笔记" })).not.toHaveAttribute("aria-current");
  });
  it("shows only supplementary topics in the notes directory, without repeating story tasks", async () => {
    setup("?work=section&targetProject=p&item=seed-hook");
    await screen.findByText("准备节点 · 统一处理");
    const nav = within(screen.getByRole("navigation", { name: "筹备内容" }));
    expect(nav.getByRole("link", { name: "补充笔记" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "故事准备" })).not.toHaveAttribute("aria-current");
    expect(nav.getByRole("link", { name: "核心卖点与独特钩子" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "信息揭示与节奏安排" })).toBeVisible();
    expect(nav.getByRole("link", { name: "本书偏好" })).toBeVisible();
    for (const label of ["题材", "主角", "行动动机", "失败代价", "结局状态与承诺兑现", "舞台、硬规则与资源限制"]) {
      expect(nav.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  });
  it("keeps old story note links accessible with story preparation active", async () => {
    setup("?work=section&targetProject=p&item=engine-protagonist");
    await screen.findByText("准备节点 · 统一处理");
    expect(screen.getByRole("link", { name: "故事准备" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "故事准备" })).toHaveAttribute("href",
      "/discussion?work=section&targetProject=p&item=engine-protagonist");
    expect(screen.queryByLabelText("补充笔记目录")).not.toBeInTheDocument();
  });
  it("does not include preparation notes inside outline work", async () => {
    setup("?work=planning&targetProject=p");
    await screen.findByText("大纲处理 · 统一处理");
    expect(screen.queryByRole("navigation", { name: "筹备内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "本书偏好" })).not.toBeInTheDocument();
  });
  it("returns to the exact entity rather than the library landing page", async () => {
    setup("?work=entity&targetProject=p&entity=person");
    await screen.findByText("设定处理 · 统一处理");
    expect(screen.getByRole("link", { name: "返回设定" })).toHaveAttribute("href",
      "/knowledge?targetProject=p&entity=person");
  });
  it.each(["entity", "planning", "writing", "materials"])("owns the explicit source return for %s", async (work) => {
    setup(`?work=${work}&targetProject=p&returnTo=%2Fwriting%23chapter`);
    await screen.findByText(/ · 统一处理$/);
    expect(screen.getByRole("link", { name: "返回来源" })).toHaveAttribute("href", "/writing#chapter");
  });
  it("does not label a rejected return URL as a source", async () => {
    setup("?work=entity&targetProject=p&entity=person&returnTo=https%3A%2F%2Fexample.com");
    await screen.findByText("设定处理 · 统一处理");
    expect(screen.getByRole("link", { name: "返回设定" })).toHaveAttribute("href", "/knowledge?targetProject=p&entity=person");
    expect(screen.queryByRole("link", { name: "返回来源" })).not.toBeInTheDocument();
  });
});
