import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CreationPreparationView } from "./creation-preparation-view";
import { buildPreparationStages } from "./creation-preparation";
import { emptyPlanningSection } from "./use-planning-draft";

const mocks = vi.hoisted(() => ({
  getCurrentProject: vi.fn(), listPlanNodes: vi.fn(), listPlanningSections: vi.fn(),
  listModelProfiles: vi.fn(), savePlanningSection: vi.fn(), createPlanNode: vi.fn(),
  enqueuePlanningAiJob: vi.fn(), jobs: [] as unknown[],
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children, ...props }: { to: string; hash?: string; children: ReactNode }) =>
    <a href={`${to}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>,
}));
vi.mock("../lib/jobs-query", () => ({ useJobs: () => ({ data: mocks.jobs }) }));
vi.mock("../lib/ai-task-preferences", async () => ({
  ...await vi.importActual<typeof import("../lib/ai-task-preferences")>("../lib/ai-task-preferences"),
  useAiTaskPreferences: () => ({ data: {}, isSuccess: true }),
}));
vi.mock("./ai-model-note", () => ({ AiModelNote: () => null }));

let stored: PlanningSection[];
let nodes: PlanNode[];
function confirmed(id: string): PlanningSection {
  return { ...emptyPlanningSection(id), content: `已决定：${id}`, storyState: "CONFIRMED", version: 1 };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<StrictMode><QueryClientProvider client={client}><ConfirmActionProvider>
    <CreationPreparationView />
  </ConfirmActionProvider></QueryClientProvider></StrictMode>);
  return client;
}
async function chooseStage(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(title) }));
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.jobs = [];
  stored = [];
  nodes = [];
  mocks.getCurrentProject.mockResolvedValue({ projectId: "project", name: "雾城来信" });
  mocks.listPlanNodes.mockImplementation(async () => [...nodes]);
  mocks.listPlanningSections.mockImplementation(async () => [...stored]);
  mocks.listModelProfiles.mockResolvedValue([]);
  mocks.savePlanningSection.mockImplementation(async (section: PlanningSection) => {
    const saved = { ...section, version: (section.version ?? 0) + 1 };
    stored = [...stored.filter((item) => item.id !== saved.id), saved];
    return saved;
  });
});
afterEach(cleanup);

describe("creation preparation workbench", () => {
  it("starts with story decisions, not chapter creation, and makes no writes on mount", async () => {
    setup();
    expect(await screen.findByRole("textbox", { name: "故事核心" })).toBeVisible();
    expect(screen.getByText("关键准备 0 / 7")).toBeVisible();
    expect(screen.queryByRole("link", { name: "进入正文" })).not.toBeInTheDocument();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
  });

  it("saves drafts separately without advancing progress or changing formal content", async () => {
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "一个收到未来来信的邮差。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-premise", content: "", pendingContent: "一个收到未来来信的邮差。", storyState: "UNSET", version: 0,
    }));
    expect(input).toHaveValue("一个收到未来来信的邮差。");
    expect(screen.getByText("关键准备 0 / 7")).toBeVisible();
  });

  it("confirms the author's text using the stored version and advances to the next decision", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), pendingContent: "收到未来来信的邮差", version: 4 }];
    setup();
    expect(await screen.findByRole("textbox", { name: "故事核心" })).toHaveValue("收到未来来信的邮差");
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(await screen.findByRole("textbox", { name: "题材与阅读期待" })).toBeVisible();
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "seed-premise", content: "收到未来来信的邮差", pendingContent: "", storyState: "CONFIRMED", version: 4,
    }));
    expect(screen.getByText("关键准备 1 / 7")).toBeVisible();
  });

  it("preserves input after a failed save and does not advance", async () => {
    mocks.savePlanningSection.mockRejectedValue(new Error("磁盘不可写"));
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "尚未保存的核心" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘不可写");
    expect(input).toHaveValue("尚未保存的核心");
    expect(screen.getByText("关键准备 0 / 7")).toBeVisible();
  });

  it("cancels switching without losing dirty input", async () => {
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "我正在推敲" } });
    await chooseStage("建立关键设定");
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("我正在推敲");
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
  });

  it("shows missing prerequisites and prevents early chapter or outline creation", async () => {
    setup();
    await chooseStage("准备开篇");
    expect(screen.getByRole("button", { name: "建立开篇章节计划" })).toBeDisabled();
    expect(screen.getByText("前序关键准备尚有 6 项待确认")).toBeVisible();
    await chooseStage("确定故事走向");
    expect(screen.getByRole("button", { name: "建立主线大纲" })).toBeDisabled();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("reuses legacy unconfirmed notes without calling them confirmed or hiding them", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), content: "以前写下的前提", version: 2 }];
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    expect(input).toHaveValue("以前写下的前提");
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("textbox", { name: "题材与阅读期待" });
    expect(stored.find((section) => section.id === "seed-premise")?.storyState).toBe("CONFIRMED");
  });

  it("keeps previously confirmed content while revising in a separate draft", async () => {
    stored = [confirmed("seed-premise")];
    setup();
    await screen.findByRole("textbox", { name: "题材与阅读期待" });
    fireEvent.click(screen.getByRole("button", { name: /故事核心/ }));
    expect(await screen.findByRole("textbox", { name: "故事核心" })).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "修订草稿" }));
    fireEvent.change(screen.getByRole("textbox", { name: "故事核心" }), { target: { value: "新的前提" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    expect(stored.find((section) => section.id === "seed-premise")).toMatchObject({
      content: "已决定：seed-premise", pendingContent: "新的前提", storyState: "CONFIRMED",
    });
    expect(screen.getByText("关键准备 0 / 7")).toBeVisible();
  });

  it("records optional deferrals without inventing confirmed facts", async () => {
    setup();
    await chooseStage("建立关键设定");
    fireEvent.click(screen.getByRole("button", { name: /关键人物关系/ }));
    fireEvent.click(screen.getByRole("button", { name: "暂不决定" }));
    await waitFor(() => expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({
      id: "cast-core-relationship", storyState: "DEFERRED", content: "",
    })));
  });

  it("offers writing only after the seven key decisions have been confirmed", async () => {
    nodes = [
      { id: "outline", kind: "OUTLINE", title: "大纲", parentId: null, archived: false, revision: 1, sortOrder: 0 },
      { id: "first", kind: "CHAPTER", title: "第一章", parentId: "volume", archived: false, revision: 1, sortOrder: 0 },
    ];
    stored = buildPreparationStages(nodes).flatMap((stage) => stage.items).filter((item) => item.required).map((item) => confirmed(item.sectionId!));
    setup();
    expect(await screen.findByRole("link", { name: "进入正文" })).toHaveAttribute("href", "/writing#first");
    expect(screen.getByText("关键准备 7 / 7")).toBeVisible();
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });

  it("does not edit or overwrite locked decisions", async () => {
    stored = [{ ...confirmed("seed-premise"), storyState: "LOCKED" }];
    setup();
    await screen.findByRole("textbox", { name: "题材与阅读期待" });
    fireEvent.click(screen.getByRole("button", { name: /故事核心/ }));
    expect(screen.getByRole("textbox", { name: "故事核心" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "修订草稿" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI 推敲讨论稿" })).toBeDisabled();
  });

  it("retains local input when AI finishes remotely, requiring an explicit reload", async () => {
    const client = setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "本地输入" } });
    act(() => client.setQueryData(["planning-sections"], [{
      ...emptyPlanningSection("seed-premise"), pendingContent: "远端生成稿", storyState: "AI_SUGGESTED", version: 1,
    }]));
    expect(input).toHaveValue("本地输入");
    fireEvent.click(await screen.findByRole("button", { name: "读取最新内容" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("本地输入");
  });

  it("rejects stale discard approval when the author edits during confirmation", async () => {
    setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "原输入" } });
    await chooseStage("建立关键设定");
    fireEvent.change(input, { target: { value: "确认期间的新输入" } });
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并切换" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("确认期间准备内容已变化");
    expect(input).toHaveValue("确认期间的新输入");
  });

  it("prevents switching and duplicate submissions during a pending save", async () => {
    let finish!: (section: PlanningSection) => void;
    mocks.savePlanningSection.mockImplementationOnce(() => new Promise<PlanningSection>((resolve) => { finish = resolve; }));
    setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "故事核心" }), { target: { value: "确认中" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(screen.getByRole("button", { name: /建立关键设定/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(mocks.savePlanningSection).toHaveBeenCalledOnce();
    await act(async () => finish({ ...confirmed("seed-premise"), content: "确认中" }));
    expect(await screen.findByRole("textbox", { name: "题材与阅读期待" })).toBeVisible();
  });

  it("generates only on explicit request, using confirmed context and keeping the task a draft", async () => {
    const base = confirmed("frame-setting");
    stored = [base, { ...emptyPlanningSection("engine-stakes"), content: "未确认的代价", storyState: "AI_SUGGESTED" }];
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    mocks.enqueuePlanningAiJob.mockResolvedValue({});
    setup();
    await screen.findByRole("textbox", { name: "故事核心" });
    const button = screen.getByRole("button", { name: "AI 推敲讨论稿" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: "seed-premise", profileId: "chat", taskKey: "workDesign", mode: "GENERATE",
      existingContext: `frame-setting: ${base.content}`,
    })));
    expect(mocks.savePlanningSection).not.toHaveBeenCalled();
    expect(screen.getByText("关键准备 1 / 7")).toBeVisible();
  });

  it("requires approval before AI replaces a saved candidate and cancels without submitting", async () => {
    stored = [{ ...emptyPlanningSection("seed-premise"), pendingContent: "保存过的讨论稿", storyState: "AI_SUGGESTED" }];
    mocks.listModelProfiles.mockResolvedValue([{ id: "chat", capability: "CHAT", hasSecret: true }]);
    setup();
    await screen.findByRole("textbox", { name: "故事核心" });
    const button = screen.getByRole("button", { name: "AI 推敲讨论稿" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("替换当前已保存的讨论稿");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.enqueuePlanningAiJob).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "故事核心" })).toHaveValue("保存过的讨论稿");
  });

  it("does not auto-switch away from dirty input when remote progress changes", async () => {
    const client = setup();
    const input = await screen.findByRole("textbox", { name: "故事核心" });
    fireEvent.change(input, { target: { value: "本地仍在编辑" } });
    act(() => client.setQueryData(["planning-sections"], [confirmed("seed-premise")]));
    await waitFor(() => expect(screen.getByText("关键准备 1 / 7")).toBeVisible());
    expect(input).toHaveValue("本地仍在编辑");
    expect(screen.queryByRole("textbox", { name: "题材与阅读期待" })).not.toBeInTheDocument();
  });
});
