import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { ChapterCreateDialog } from "./chapter-create-dialog";
import { FreePlanningEditor } from "./free-planning-editor";
import { emptyPlanningSection, usePlanningDraft } from "./use-planning-draft";
import type { PlanNode } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ createChapter: vi.fn() }));
vi.mock("./create-chapter", () => ({ createChapter: mocks.createChapter }));
const volume: PlanNode = { id: "volume-1", kind: "VOLUME", title: "第一卷", parentId: null, revision: 1, sortOrder: 0, archived: false };
function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode><QueryClientProvider client={new QueryClient()}>
    <ConfirmActionProvider>{children}</ConfirmActionProvider>
  </QueryClientProvider></StrictMode>;
}
function planning(onAdopt: () => void, id = "notes") {
  function Editor() {
    const draft = usePlanningDraft(id, { ...emptyPlanningSection(id), content: "当前笔记", pendingContent: "候选笔记" }, true);
    return <FreePlanningEditor draft={draft} label="笔记" placeholder="" stateLabels={{ UNSET: "未定", AI_SUGGESTED: "候选",
      CONFIRMED: "确定", LOCKED: "锁定", DEFERRED: "暂缓", UNKNOWN: "未知", AUTHOR_RESERVED: "作者保留",
      RETIRED: "废弃" }} onSave={vi.fn()} onAdopt={onAdopt} />;
  }
  return <Editor />;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("editor confirmation snapshots", () => {
  it("closes an unchanged creation form under StrictMode without a confirmation", () => {
    const close = vi.fn();
    render(<ChapterCreateDialog projectId="project-1" nodes={[volume]} onClose={close} onCreated={vi.fn()} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "关闭新建章节" }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("preserves cancelled creation inputs and closes only after approval", async () => {
    const close = vi.fn();
    render(<ChapterCreateDialog projectId="project-1" nodes={[volume]} onClose={close} onCreated={vi.fn()} />, { wrapper });
    fireEvent.change(screen.getByLabelText("章节名称"), { target: { value: "入城" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭新建章节" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("章节名称")).toHaveValue("入城");
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭新建章节" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃章节信息" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it("retains creation fields edited during confirmation and prevents creation while closing", async () => {
    const close = vi.fn();
    render(<ChapterCreateDialog projectId="project-1" nodes={[volume]} onClose={close} onCreated={vi.fn()} />, { wrapper });
    fireEvent.change(screen.getByLabelText("章节名称"), { target: { value: "初稿" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭新建章节" }));
    fireEvent.click(screen.getByRole("button", { name: "创建章节" }));
    expect(mocks.createChapter).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("章节名称"), { target: { value: "新输入" } });
    fireEvent.click(screen.getByRole("button", { name: "放弃章节信息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("章节信息已变化");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText("章节名称")).toHaveValue("新输入");
  });
  it("permits only one creation request while IPC is pending", async () => {
    let finish!: (value: PlanNode) => void;
    mocks.createChapter.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<ChapterCreateDialog projectId="project-1" nodes={[volume]} onClose={vi.fn()} onCreated={vi.fn()} />, { wrapper });
    const button = screen.getByRole("button", { name: "创建章节" });
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.createChapter).toHaveBeenCalledOnce();
    await act(async () => finish({ ...volume, id: "chapter-1", kind: "CHAPTER", parentId: volume.id }));
  });
  it("cancels note replacement and adopts only the confirmed candidate", async () => {
    const adopt = vi.fn();
    render(planning(adopt), { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "采用为笔记" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "采用为笔记" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "采用为笔记" }));
    await waitFor(() => expect(adopt).toHaveBeenCalledOnce());
  });
  it("retains newer notes and candidates after stale replacement approval", async () => {
    const adopt = vi.fn();
    render(planning(adopt), { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "采用为笔记" }));
    fireEvent.change(screen.getByLabelText("笔记候选"), { target: { value: "新的候选" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "采用为笔记" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("笔记或候选已变化");
    expect(screen.getByLabelText("笔记候选")).toHaveValue("新的候选");
    expect(adopt).not.toHaveBeenCalled();
  });
});
