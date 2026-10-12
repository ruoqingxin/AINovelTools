import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectActionsProvider, useProjectActions } from "./project-actions-provider";
import { UnsavedChangesProvider, useUnsavedChangesGuard } from "./unsaved-changes-provider";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(), openDialog: vi.fn(), saveDialog: vi.fn(), openProject: vi.fn(), createProject: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useBlocker: () => ({ status: "idle" }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openDialog, save: mocks.saveDialog }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"),
  openProject: mocks.openProject, createProject: mocks.createProject,
}));

function Actions({ dirty = false }: { dirty?: boolean }) {
  const actions = useProjectActions();
  useUnsavedChangesGuard(dirty, "正文还有未保存内容。");
  return <div>
    <button onClick={() => void actions.create()}>create</button>
    <button onClick={() => void actions.open()}>open</button>
    <button onClick={() => void actions.openRecent({ name: "another", root: "E:\\another", lastOpenedAt: "0" })}>recent</button>
    <span data-testid="busy">{actions.busy ?? "idle"}</span>
    {actions.error ? <p role="alert">{actions.error}</p> : null}
  </div>;
}

function setup(dirty = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["current-project"], { projectId: "old", name: "old" });
  client.setQueryData(["discussion-sessions"], [{ id: "old-session" }]);
  client.setQueryData(["audit-flow-settings"], { admission: false });
  client.setQueryData(["model-profiles"], [{ id: "shared-model" }]);
  render(<QueryClientProvider client={client}><UnsavedChangesProvider>
    <ProjectActionsProvider><Actions dirty={dirty} /></ProjectActionsProvider>
  </UnsavedChangesProvider></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.navigate.mockResolvedValue(undefined);
  mocks.openDialog.mockResolvedValue("E:\\another");
  mocks.saveDialog.mockResolvedValue("E:\\new-story");
  mocks.openProject.mockResolvedValue({ projectId: "new", name: "another" });
  mocks.createProject.mockResolvedValue({ projectId: "created", name: "new-story" });
});
afterEach(cleanup);

describe("project switching", () => {
  it("clears old project caches, preserves shared model settings, and resumes writing", async () => {
    const client = setup();
    fireEvent.click(screen.getByText("recent"));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("idle"));
    expect(mocks.openProject).toHaveBeenCalledWith("E:\\another");
    expect(client.getQueryData(["current-project"])).toEqual({ projectId: "new", name: "another" });
    expect(client.getQueryData(["discussion-sessions"])).toBeUndefined();
    expect(client.getQueryData(["audit-flow-settings"])).toBeUndefined();
    expect(client.getQueryData(["model-profiles"])).toEqual([{ id: "shared-model" }]);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/writing", search: {}, hash: "", replace: true, ignoreBlocker: true });
  });
  it("does not switch or erase content when the author chooses to stay", async () => {
    const client = setup(true);
    fireEvent.click(screen.getByText("recent"));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("正文还有未保存内容");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("idle"));
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(client.getQueryData(["discussion-sessions"])).toEqual([{ id: "old-session" }]);
  });
  it("keeps keyboard focus inside the confirmation dialog", async () => {
    setup(true);
    fireEvent.click(screen.getByText("recent"));
    await screen.findByRole("alertdialog");
    const stay = screen.getByRole("button", { name: "继续编辑" });
    const leave = screen.getByRole("button", { name: "放弃修改并离开" });
    expect(stay).toHaveFocus();
    fireEvent.keyDown(stay, { key: "Tab", shiftKey: true });
    expect(leave).toHaveFocus();
    fireEvent.keyDown(leave, { key: "Tab" });
    expect(stay).toHaveFocus();
    fireEvent.keyDown(stay, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.openProject).not.toHaveBeenCalled();
  });
  it("switches only after an explicit discard decision", async () => {
    setup(true);
    fireEvent.click(screen.getByText("recent"));
    await screen.findByRole("alertdialog");
    expect(mocks.openProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    await waitFor(() => expect(mocks.openProject).toHaveBeenCalledOnce());
  });
  it("retains the current project and cache if opening fails", async () => {
    mocks.openProject.mockRejectedValue(new Error("作品目录不存在"));
    const client = setup();
    fireEvent.click(screen.getByText("open"));
    expect(await screen.findByRole("alert")).toHaveTextContent("作品目录不存在");
    expect(client.getQueryData(["current-project"])).toEqual({ projectId: "old", name: "old" });
    expect(client.getQueryData(["discussion-sessions"])).toEqual([{ id: "old-session" }]);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("keeps the unsaved guard active after an unsuccessful switch", async () => {
    mocks.openProject.mockRejectedValue(new Error("作品目录不存在"));
    setup(true);
    fireEvent.click(screen.getByText("recent"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("recent"));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("正文还有未保存内容");
    expect(mocks.openProject).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  });
  it("treats cancellation of the native picker as a no-op", async () => {
    mocks.openDialog.mockResolvedValue(null);
    setup(true);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("idle"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });
  it("creates a named project and opens its creation workspace", async () => {
    setup();
    fireEvent.click(screen.getByText("create"));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.createProject).toHaveBeenCalledWith("E:\\new-story", "new-story");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", search: { manage: "1" }, hash: "", replace: true, ignoreBlocker: true });
  });
  it("serializes commands from multiple entry points", async () => {
    let resolveDialog!: (path: string | null) => void;
    mocks.openDialog.mockImplementation(() => new Promise((resolve) => { resolveDialog = resolve; }));
    setup();
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("recent"));
    expect(mocks.openProject).not.toHaveBeenCalled();
    await act(async () => { resolveDialog(null); });
    expect(mocks.openDialog).toHaveBeenCalledOnce();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });
});
