import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

const mocks = vi.hoisted(() => ({
  pathname: "/knowledge/settings", project: { projectId: "p1", name: "夜行信使" } as { projectId: string; name: string } | null,
  getCurrentProject: vi.fn(), listRecentProjects: vi.fn(), getHealth: vi.fn(), getBootstrapStatus: vi.fn(),
  listAllRecoveryLogs: vi.fn(), listJobs: vi.fn(), navigate: vi.fn(), openProject: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, search, children, activeOptions: _options, ...props }: {
    to: string; search?: { manage?: string }; children: ReactNode; activeOptions?: unknown;
  }) => <a href={`${to}${search?.manage ? `?manage=${search.manage}` : ""}`} {...props}>{children}</a>,
  Outlet: () => <div><p>Current workspace</p><input aria-label="Local note" defaultValue="" /></div>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
  useNavigate: () => mocks.navigate,
  useBlocker: () => ({ status: "idle" }),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AppShell /></QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pathname = "/knowledge/settings";
  mocks.project = { projectId: "p1", name: "夜行信使" };
  mocks.getCurrentProject.mockImplementation(() => Promise.resolve(mocks.project));
  mocks.listRecentProjects.mockResolvedValue([{ name: "雾城来信", root: "E:\\story", lastOpenedAt: "0" }]);
  mocks.getHealth.mockResolvedValue({ sqliteVersion: "test", schemaVersion: 48 });
  mocks.getBootstrapStatus.mockResolvedValue({});
  mocks.listAllRecoveryLogs.mockResolvedValue([]);
  mocks.listJobs.mockResolvedValue([]);
});
afterEach(cleanup);

describe("global workspace shell", () => {
  it("separates five primary destinations from global tools and settings", async () => {
    setup();
    await screen.findByRole("link", { name: "资料" });
    const navigation = within(screen.getByRole("complementary", { name: "主要导航" }));
    expect(navigation.getAllByRole("link").map((link) => link.getAttribute("aria-label")))
      .toEqual(["写作", "构思", "大纲", "资料", "待办", "设置"]);
    expect(within(screen.getByLabelText("全局工具")).getByRole("link", { name: "搜索" })).toBeVisible();
    expect(within(screen.getByLabelText("全局工具")).getByRole("link", { name: "后台活动" })).toBeVisible();
    expect(navigation.queryByRole("link", { name: "项目" })).not.toBeInTheDocument();
  });
  it.each([
    ["/knowledge/settings", "资料"], ["/knowledge/materials", "资料"],
    ["/knowledge/records", "资料"], ["/knowledge/review", "待办"], ["/chapters", "写作"],
  ])("keeps the parent selected for %s", async (path, label) => {
    mocks.pathname = path;
    setup();
    expect(await screen.findByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  });
  it("disables project destinations but keeps settings and project management available without a project", async () => {
    mocks.project = null;
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "写作" })).toBeDisabled());
    expect(screen.getByRole("link", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("link", { name: "搜索" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "选择作品" }));
    expect(screen.getByRole("button", { name: "新建作品" })).toBeVisible();
    expect(screen.getByRole("link", { name: "作品管理" })).toHaveAttribute("href", "/?manage=1");
  });
  it("shows recent projects and closes the picker with Escape", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "选择作品" }));
    expect(await screen.findByRole("button", { name: "雾城来信" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "作品选择" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择作品" })).toHaveFocus();
  });
  it("offers accessible collapsed and narrow-window navigation controls", async () => {
    setup();
    await screen.findByRole("link", { name: "写作" });
    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-nav-collapsed", "true");
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-mobile-nav", "true");
    fireEvent.click(screen.getByRole("button", { name: "关闭导航遮罩" }));
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("data-mobile-nav");
  });
  it("closes narrow-window navigation with Escape and restores focus", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("data-mobile-nav");
    expect(screen.getByRole("button", { name: "打开导航" })).toHaveFocus();
  });
  it("retains the outgoing workspace's inputs if opening another project fails", async () => {
    let rejectOpen!: (error: Error) => void;
    mocks.openProject.mockImplementation(() => new Promise((_resolve, reject) => { rejectOpen = reject; }));
    setup();
    await screen.findByRole("link", { name: "写作" });
    fireEvent.change(screen.getByLabelText("Local note"), { target: { value: "not saved yet" } });
    fireEvent.click(screen.getByRole("button", { name: "选择作品" }));
    fireEvent.click(await screen.findByRole("button", { name: "雾城来信" }));
    expect(await screen.findByRole("status")).toHaveTextContent("正在切换作品");
    await act(async () => { rejectOpen(new Error("作品目录不存在")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("作品目录不存在");
    expect(screen.getByLabelText("Local note")).toHaveValue("not saved yet");
  });
  it("keeps both ongoing work and failed work visible in the activity summary", async () => {
    mocks.listJobs.mockResolvedValue([{ status: "RUNNING" }, { status: "FAILED", acknowledgedAt: null }]);
    setup();
    const activity = screen.getByRole("link", { name: "后台活动" });
    await waitFor(() => expect(activity).toHaveAttribute("title", "后台活动 · 1 项进行中 · 1 项失败"));
    expect(within(activity).getByLabelText("1 项任务失败")).toBeInTheDocument();
  });
});
