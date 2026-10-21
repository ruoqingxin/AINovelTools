import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyProjectView } from "./empty-project-view";
import { ProjectActionsProvider } from "../shell/project-actions-provider";
import { lastWritingChapterKey } from "./project-workspace-utils";

const mocks = vi.hoisted(() => ({
  getCurrentProject: vi.fn(), listRecentProjects: vi.fn(), listPlanNodes: vi.fn(),
  listPlanningSections: vi.fn(), savePlanningSection: vi.fn(), createPlanNode: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, search, children, ...props }: { to: string; hash?: string; search?: Record<string, string>; children: ReactNode }) => <a href={`${to}${search ? `?${new URLSearchParams(search)}` : ""}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ProjectActionsProvider><EmptyProjectView /></ProjectActionsProvider></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  mocks.getCurrentProject.mockResolvedValue(null);
  mocks.listRecentProjects.mockResolvedValue([]);
  mocks.listPlanNodes.mockResolvedValue([]);
  mocks.listPlanningSections.mockResolvedValue([]);
});
afterEach(cleanup);

describe("EmptyProjectView", () => {
  it("keeps create and open available without a current project", () => {
    setup();

    expect(screen.getByRole("heading", { name: "作品管理" })).toBeVisible();
    expect(screen.getByRole("button", { name: "新建作品" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "打开作品" })).toBeEnabled();
    expect(screen.queryByText("第一次使用？按这个顺序开始")).not.toBeInTheDocument();
  });

  it("continues the remembered active chapter for this project", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanNodes.mockResolvedValue([
      { id: "first", kind: "CHAPTER", archived: false },
      { id: "last", kind: "CHAPTER", archived: false },
    ]);
    window.localStorage.setItem(lastWritingChapterKey("project"), "last");
    setup();
    expect(await screen.findByRole("link", { name: "继续写作" })).toHaveAttribute("href", "/writing#last");
  });

  it("does not continue an archived or another project's chapter", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanNodes.mockResolvedValue([
      { id: "archived", kind: "CHAPTER", archived: true },
      { id: "first", kind: "CHAPTER", archived: false },
    ]);
    window.localStorage.setItem(lastWritingChapterKey("project"), "archived");
    window.localStorage.setItem(lastWritingChapterKey("another"), "elsewhere");
    setup();
    expect(await screen.findByRole("link", { name: "继续写作" })).toHaveAttribute("href", "/writing#first");
  });

  it("creates a chapter without reading or changing author planning", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanNodes.mockResolvedValue([
      { id: "design", kind: "WORK_DESIGN", parentId: null },
      { id: "manager", kind: "VOLUME_MANAGER", parentId: null },
      { id: "volume", kind: "VOLUME", parentId: "manager" },
    ]);
    mocks.listPlanningSections.mockRejectedValue(new Error("规划读取失败"));
    mocks.createPlanNode.mockResolvedValue({ id: "created", kind: "CHAPTER", parentId: "volume" });
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建章节" })).toBeEnabled());
    expect(screen.getByRole("link", { name: "开始创作准备" })).toHaveAttribute("href", "/planning?mode=prepare");
    fireEvent.click(screen.getByRole("button", { name: "新建章节" }));
    expect(screen.queryByLabelText("一句话核心")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建章节" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/writing", hash: "created" }));
    expect(mocks.createPlanNode).toHaveBeenCalledWith({ kind: "CHAPTER", title: "第1章", parentId: "volume" });
    expect(mocks.listPlanningSections).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("keeps chapter creation inputs after a failed create", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.createPlanNode.mockRejectedValue(new Error("创建失败"));
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建章节" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建章节" }));
    fireEvent.change(screen.getByLabelText("章节名称"), { target: { value: "第1章·入城" } });
    fireEvent.click(screen.getByRole("button", { name: "创建章节" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("章节名称")).toHaveValue("第1章·入城");
    expect(screen.getByRole("button", { name: "创建章节" })).toBeEnabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("continues to the created chapter without reloading the window", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanNodes.mockResolvedValue([
      { id: "design", kind: "WORK_DESIGN", parentId: null },
      { id: "manager", kind: "VOLUME_MANAGER", parentId: null },
      { id: "volume", kind: "VOLUME", parentId: "manager" },
    ]);
    mocks.createPlanNode.mockResolvedValue({ id: "created", kind: "CHAPTER", parentId: "volume" });
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "新建章节" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建章节" }));
    fireEvent.change(screen.getByLabelText("章节名称"), { target: { value: "故事从这里开始" } });
    fireEvent.click(screen.getByRole("button", { name: "创建章节" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/writing", hash: "created" }));
    expect(screen.queryByLabelText("章节名称")).not.toBeInTheDocument();
  });
});
