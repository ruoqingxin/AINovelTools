import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyProjectView } from "./empty-project-view";
import { emptyPlanningSection } from "./use-planning-draft";
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
  Link: ({ to, hash, children, ...props }: { to: string; hash?: string; children: ReactNode }) => <a href={`${to}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>,
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

  it("uses the original planning version for quick start and advances it after a partial success", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanNodes.mockResolvedValue([
      { id: "design", kind: "WORK_DESIGN", parentId: null },
      { id: "manager", kind: "VOLUME_MANAGER", parentId: null },
      { id: "volume", kind: "VOLUME", parentId: "manager" },
    ]);
    const stored = { ...emptyPlanningSection("seed-premise"), content: "已有核心", version: 4 };
    mocks.listPlanningSections.mockResolvedValue([stored]);
    mocks.savePlanningSection.mockImplementation((section) => Promise.resolve({ ...section, version: section.version + 1 }));
    mocks.createPlanNode.mockRejectedValue(new Error("节点创建失败"));
    const client = setup();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一章" }));
    const input = screen.getByLabelText("一句话核心");
    await waitFor(() => expect(input).toHaveValue("已有核心"));
    fireEvent.change(input, { target: { value: "我的新核心" } });
    act(() => client.setQueryData(["planning-sections"], [{ ...stored, content: "外部核心", version: 8 }]));
    fireEvent.click(screen.getByRole("button", { name: "创建第一章并开始写" }));
    await screen.findByRole("alert");
    expect(mocks.savePlanningSection).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4, content: "我的新核心" }));
    fireEvent.click(screen.getByRole("button", { name: "创建第一章并开始写" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledTimes(2));
    expect(mocks.savePlanningSection).toHaveBeenLastCalledWith(expect.objectContaining({ version: 5 }));
  });

  it("cannot submit quick start until existing planning has been read", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanningSections.mockRejectedValue(new Error("规划读取失败"));
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一章" }));
    fireEvent.change(screen.getByLabelText("一句话核心"), { target: { value: "新核心" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "创建第一章并开始写" })).toBeDisabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("continues to the created chapter without reloading the window", async () => {
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "existing" });
    mocks.listPlanNodes.mockResolvedValue([
      { id: "design", kind: "WORK_DESIGN", parentId: null },
      { id: "manager", kind: "VOLUME_MANAGER", parentId: null },
      { id: "volume", kind: "VOLUME", parentId: "manager" },
    ]);
    mocks.savePlanningSection.mockImplementation((section) => Promise.resolve({ ...section, version: 1 }));
    mocks.createPlanNode.mockResolvedValue({ id: "created", kind: "CHAPTER", parentId: "volume" });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一章" }));
    fireEvent.change(screen.getByLabelText("一句话核心"), { target: { value: "故事从这里开始" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "创建第一章并开始写" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "创建第一章并开始写" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/writing", hash: "created" }));
    expect(screen.queryByLabelText("一句话核心")).not.toBeInTheDocument();
  });
});
