import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyProjectView } from "./empty-project-view";
import { emptyPlanningSection } from "./use-planning-draft";

const mocks = vi.hoisted(() => ({
  getCurrentProject: vi.fn(), listRecentProjects: vi.fn(), listPlanNodes: vi.fn(),
  listPlanningSections: vi.fn(), savePlanningSection: vi.fn(), createPlanNode: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><EmptyProjectView /></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentProject.mockResolvedValue(null);
  mocks.listRecentProjects.mockResolvedValue([]);
  mocks.listPlanNodes.mockResolvedValue([]);
  mocks.listPlanningSections.mockResolvedValue([]);
});
afterEach(cleanup);

describe("EmptyProjectView", () => {
  it("shows disabled project actions before project services exist", () => {
    setup();

    expect(screen.getByRole("heading", { name: "小说工程" })).toBeVisible();
    expect(screen.getByRole("button", { name: "新建工程" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "打开工程" })).toBeEnabled();
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
    fireEvent.click(await screen.findByRole("button", { name: "先写一段看看" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "先写一段看看" }));
    fireEvent.change(screen.getByLabelText("一句话核心"), { target: { value: "新核心" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "创建第一章并开始写" })).toBeDisabled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });
});
