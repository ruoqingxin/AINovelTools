import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataManagementView } from "./data-management-view";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
const mocks = vi.hoisted(() => ({ enqueueJob: vi.fn(), getCurrentProject: vi.fn(), listJobs: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("../lib/tauri-client", async () => ({ ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"),
  enqueueJob: mocks.enqueueJob, getCurrentProject: mocks.getCurrentProject, listJobs: mocks.listJobs }));
function renderView(onDirtyChange = vi.fn(), customConfirmation = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = <DataManagementView onDirtyChange={onDirtyChange} />;
  return { ...render(<QueryClientProvider client={client}>
    {customConfirmation ? <ConfirmActionProvider>{content}</ConfirmActionProvider> : content}</QueryClientProvider>), client };
}
describe("data maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1", name: "铜铃之城" });
    mocks.listJobs.mockResolvedValue([]);
    mocks.enqueueJob.mockResolvedValue({ id: "job-1", status: "QUEUED", progress: 0 });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("creates a backup once and links its actual queued job", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "创建备份" }));
    await waitFor(() => expect(mocks.enqueueJob).toHaveBeenCalledWith("BACKUP", "{}"));
    expect(await screen.findByRole("link", { name: "查看任务结果" })).toHaveAttribute("href", "/jobs?jobId=job-1");
  });
  it("requires explicit source and target, confirms restore and retains paths on failure", async () => {
    const dirty = vi.fn();
    renderView(dirty);
    await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(screen.getByRole("button", { name: "校验并恢复" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("备份目录"), { target: { value: "E:\\Backup\\one" } });
    fireEvent.change(screen.getByLabelText("新作品目录"), { target: { value: "E:\\Restored" } });
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复" }));
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "校验并恢复" })).toBeEnabled());
    confirm.mockReturnValue(true);
    mocks.enqueueJob.mockRejectedValueOnce(new Error("queue unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("queue unavailable");
    expect(screen.getByLabelText("新作品目录")).toHaveValue("E:\\Restored");
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复" }));
    await screen.findByText("等待执行");
    expect(mocks.enqueueJob).toHaveBeenLastCalledWith("RESTORE_VERIFY", JSON.stringify({ source: "E:\\Backup\\one", target: "E:\\Restored" }));
    expect(screen.getByLabelText("新作品目录")).toHaveValue("");
  });
  it("uses a directory picker for source and a new location picker for target", async () => {
    renderView();
    await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    mocks.open.mockResolvedValue("E:\\Backup");
    mocks.save.mockResolvedValue("E:\\NewNovel");
    fireEvent.click(screen.getByLabelText("选择备份目录"));
    await waitFor(() => expect(screen.getByLabelText("备份目录")).toHaveValue("E:\\Backup"));
    fireEvent.click(screen.getByLabelText("选择新作品位置"));
    await waitFor(() => expect(screen.getByLabelText("新作品目录")).toHaveValue("E:\\NewNovel"));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  });
  it("prevents duplicate submissions while waiting for native IPC", async () => {
    let finish!: (value: unknown) => void;
    mocks.enqueueJob.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderView();
    const button = await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.enqueueJob).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "提交中…" })).toBeDisabled();
    await act(async () => finish({ id: "job-1", status: "QUEUED", progress: 0 }));
  });
  it("never enqueues maintenance without an open project", async () => {
    mocks.getCurrentProject.mockResolvedValue(null);
    renderView();
    await screen.findByText("请先打开作品");
    expect(screen.queryByRole("button", { name: "创建备份" })).not.toBeInTheDocument();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });
  it("locks restoration while confirming, preserves cancelled paths and allows retry", async () => {
    renderView(vi.fn(), true);
    await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.change(screen.getByLabelText("备份目录"), { target: { value: "E:\\Backup" } });
    fireEvent.change(screen.getByLabelText("新作品目录"), { target: { value: "E:\\NewNovel" } });
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("E:\\NewNovel");
    expect(screen.getByLabelText("新作品目录")).toBeDisabled();
    expect(screen.getByRole("button", { name: "备份" })).toBeDisabled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "校验并恢复" })).toBeEnabled());
    expect(screen.getByLabelText("新作品目录")).toHaveValue("E:\\NewNovel");
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复" }));
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复到新目录" }));
    await screen.findByText("等待执行");
    expect(mocks.enqueueJob).toHaveBeenCalledOnce();
    expect(mocks.enqueueJob).toHaveBeenCalledWith("RESTORE_VERIFY", JSON.stringify({ source: "E:\\Backup", target: "E:\\NewNovel" }));
  });
  it("does not enqueue a restore for a project changed while confirmation is open", async () => {
    const { client } = renderView(vi.fn(), true);
    await screen.findByRole("button", { name: "创建备份" });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.change(screen.getByLabelText("备份目录"), { target: { value: "E:\\Backup" } });
    fireEvent.change(screen.getByLabelText("新作品目录"), { target: { value: "E:\\NewNovel" } });
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复" }));
    act(() => client.setQueryData(["current-project"], { projectId: "project-2", name: "另一作品" }));
    fireEvent.click(screen.getByRole("button", { name: "校验并恢复到新目录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("作品或恢复路径已变化");
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(screen.getByLabelText("新作品目录")).toHaveValue("E:\\NewNovel");
  });
});
