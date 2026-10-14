import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterCreationWorkspace } from "./chapter-creation-workspace";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";

type WorkspaceProps = ComponentProps<typeof ChapterCreationWorkspace>;
type ManuscriptState = WorkspaceProps["state"];
const panels = vi.hoisted(() => ({ ai: vi.fn(), extraction: vi.fn(), facts: vi.fn() }));

vi.mock("./ai-writing-panel", () => ({
  AiWritingPanel: (props: Record<string, unknown>) => {
    panels.ai(props);
    const [instruction, setInstruction] = useState("");
    if (props.mode === "create") return <div>
      <label>AI 补充意见<input value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
      <button onClick={props.onOpenAdmissionReview as () => void}>处理准入</button>
      <button onClick={props.onSelectText as () => void}>选择正文片段</button>
    </div>;
    if (props.mode === "review") return <div>
      <p>检查快照：{String(props.draft)}</p>
      <button onClick={props.onReturnToEditor as () => void}>就地修改</button>
      <button onClick={props.onOpenChapterPlan as () => void}>就地查看计划</button>
    </div>;
    return null;
  },
}));
vi.mock("./manuscript-candidate-editor", () => ({ ManuscriptCandidateEditor: () => <p>共享编辑器</p> }));
vi.mock("./manuscript-reader", () => ({ ManuscriptReader: () => <p>正式版本</p> }));
vi.mock("./planning-discussion-sources", () => ({ PlanningDiscussionSources: () => <p>讨论流转记录</p> }));
vi.mock("./chapter-entity-references", () => ({ ChapterEntityReferencePanel: () => <p>本章参考资料</p> }));
vi.mock("./manuscript-versions-panel", () => ({
  ManuscriptVersionsPanel: (props: { onRecoverLatest: () => void }) =>
    <button onClick={props.onRecoverLatest}>恢复草稿</button>,
}));
vi.mock("./chapter-extraction-panel", () => ({
  ChapterExtractionPanel: (props: { onOpenFactReview: () => void; onOpenManuscript: () => void; onPendingChange?: (pending: boolean) => void }) => {
    panels.extraction(props);
    const [value, setValue] = useState("");
    return <div><button onClick={props.onOpenFactReview}>转入事实审核</button>
      <input aria-label="提取编辑" value={value} onChange={(event) => { setValue(event.target.value); props.onPendingChange?.(Boolean(event.target.value)); }} />
      <button onClick={props.onOpenManuscript}>查看已保存正文</button></div>;
  },
}));
vi.mock("./knowledge-review-view", () => ({
  KnowledgeReviewView: (props: { onOpenManuscript: () => void }) => {
    panels.facts(props);
    return <div><p>本章事实</p><button onClick={props.onOpenManuscript}>查看已保存正文</button></div>;
  },
}));

const doc = (text: string) => JSON.stringify({
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
function makeState(overrides: Partial<ManuscriptState> = {}) {
  return {
    manuscript: { isSuccess: true, isPending: false, isError: false, data: { id: "revision-1", createdAt: "0" } },
    history: { isSuccess: true, isPending: false, isError: false, data: [] },
    recovery: { data: [] },
    localDraft: { isSuccess: true, isPending: false, isError: false },
    draftReady: true, draftNeedsPersistence: false, savingLocalDraft: false, draftStorageError: null,
    persistLocalDraft: vi.fn(), discardLocalDraft: vi.fn(), reloadLocalDraft: vi.fn(),
    manuscriptTab: "candidate", setManuscriptTab: vi.fn(),
    draft: doc("已保存内容"), editor: { id: "shared-editor" }, chapterDirty: false,
    savingDraft: false, saveDraft: vi.fn().mockResolvedValue(undefined),
    refreshChapterMemory: vi.fn().mockResolvedValue(undefined),
    recoverLatest: vi.fn(), mergeResult: null,
    ...overrides,
  } as unknown as ManuscriptState;
}
function makeProps(state = makeState()): WorkspaceProps {
  return {
    chapter: { id: "chapter-1", kind: "CHAPTER", title: "入城", parentId: "volume-1", sortOrder: 0, revision: 1, archived: false },
    chapterPlan: "寻找师父", volumePlan: "", planDirty: false, savingPlan: false,
    onPlanChange: vi.fn(), onSavePlan: vi.fn().mockResolvedValue(undefined),
    auditFlow: { admission: true, manuscript: true, knowledge: true }, state,
  };
}

describe("ChapterCreationWorkspace", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/writing");
  });

  it("opens chapter-plan deep links in the existing assistant without activating AI creation", () => {
    window.history.replaceState(null, "", "/writing?assistant=plan#chapter-1");
    render(<ChapterCreationWorkspace {...makeProps()} pendingChapterPlan="讨论送来的候选" />);
    expect(screen.getByRole("tab", { name: "本章计划" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("讨论送来的候选")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "本章计划" })).toBeVisible();
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ active: false, mode: "create" }));
  });

  it.each(["ai", "review"])("opens the canonical %s assistant from author queue links", (assistant) => {
    window.history.replaceState(null, "", `/writing?assistant=${assistant}&purpose=admission&returnTo=%2Freview#chapter-1`);
    render(<ChapterCreationWorkspace {...makeProps()} />);
    expect(screen.getByRole("button", { name: "收起写作助手" })).toBeVisible();
    expect(screen.getByRole("link", { name: "返回来源" })).toHaveAttribute("href", "/review");
    if (assistant === "review") {
      expect(screen.getByLabelText("检查对象")).toHaveValue("admission");
      expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "review", reviewPurpose: "admission", active: true }));
    } else expect(screen.getByLabelText("AI 补充意见")).toBeVisible();
  });

  it("opens the editor by default and shares the live draft and editor with both review purposes", () => {
    const state = makeState({ chapterDirty: true, draft: doc("最新修改") });
    render(<ChapterCreationWorkspace {...makeProps(state)} />);
    expect(screen.getByText("共享编辑器")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存正文" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "展开写作助手" })).toBeVisible();
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ editor: state.editor, draft: state.draft }));
    fireEvent.click(screen.getByRole("button", { name: "检查正文" }));
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: "review", reviewPurpose: "manuscript", editor: state.editor, draft: state.draft,
    }));
    fireEvent.change(screen.getByLabelText("检查对象"), { target: { value: "admission" } });
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: "review", reviewPurpose: "admission", editor: state.editor, draft: state.draft,
    }));
    fireEvent.click(screen.getByRole("button", { name: "就地修改" }));
    expect(state.setManuscriptTab).toHaveBeenCalledWith("candidate");
    fireEvent.click(screen.getByRole("button", { name: "就地查看计划" }));
    expect(screen.getByRole("textbox", { name: "本章计划" })).toBeVisible();
  });

  it("preserves AI input through assistant tabs and collapsing the assistant", () => {
    render(<ChapterCreationWorkspace {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.change(screen.getByLabelText("AI 补充意见"), { target: { value: "保持克制" } });
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    fireEvent.click(screen.getByRole("tab", { name: "AI 写作" }));
    expect(screen.getByLabelText("AI 补充意见")).toHaveValue("保持克制");
    fireEvent.click(screen.getByRole("button", { name: "收起写作助手" }));
    expect(screen.getByLabelText("AI 补充意见")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    expect(screen.getByLabelText("AI 补充意见")).toHaveValue("保持克制");
    fireEvent.click(screen.getByRole("button", { name: "处理准入" }));
    expect(screen.getByLabelText("检查对象")).toHaveValue("admission");
  });

  it("keeps chapter-plan edits and saves them without leaving the editor", () => {
    const savePlan = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const [plan, setPlan] = useState("寻找师父");
      return <ChapterCreationWorkspace {...makeProps()} chapterPlan={plan} planDirty={plan !== "寻找师父"}
        onPlanChange={setPlan} onSavePlan={savePlan} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    fireEvent.change(screen.getByRole("textbox", { name: "本章计划" }), { target: { value: "在城门发生冲突" } });
    fireEvent.click(screen.getByRole("tab", { name: "AI 写作" }));
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    expect(screen.getByRole("textbox", { name: "本章计划" })).toHaveValue("在城门发生冲突");
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    expect(savePlan).toHaveBeenCalledOnce();
    expect(screen.getByText("共享编辑器")).toBeVisible();
  });

  it("saves with Ctrl+S or Cmd+S only inside the active manuscript editor", () => {
    const state = makeState({ chapterDirty: true });
    const props = makeProps(state);
    const view = render(<ChapterCreationWorkspace {...props} />);
    const editor = screen.getByRole("region", { name: "正文编辑" });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    expect(state.saveDraft).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.keyDown(screen.getByLabelText("AI 补充意见"), { key: "s", ctrlKey: true });
    expect(state.saveDraft).toHaveBeenCalledTimes(2);
    view.rerender(<ChapterCreationWorkspace {...props} state={{ ...state, savingDraft: true }} />);
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    view.rerender(<ChapterCreationWorkspace {...props} state={{ ...state, chapterDirty: false }} />);
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(state.saveDraft).toHaveBeenCalledTimes(2);
  });

  it("returns to text selection on narrow screens without clearing assistant input", async () => {
    const media = vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const focus = vi.fn();
    const state = makeState({ editor: { commands: { focus } } as unknown as ManuscriptState["editor"] });
    try {
      render(<ChapterCreationWorkspace {...makeProps(state)} />);
      fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
      fireEvent.change(screen.getByLabelText("AI 补充意见"), { target: { value: "只改对话" } });
      fireEvent.click(screen.getByRole("button", { name: "选择正文片段" }));
      expect(state.setManuscriptTab).toHaveBeenCalledWith("candidate");
      expect(screen.getByLabelText("AI 补充意见")).not.toBeVisible();
      await waitFor(() => expect(focus).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
      expect(screen.getByLabelText("AI 补充意见")).toHaveValue("只改对话");
    } finally { media.mockRestore(); }
  });

  it("retains pending execution cards and confirms before replacing plan edits", async () => {
    const props = makeProps();
    const adopt = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(<ChapterCreationWorkspace {...props} pendingChapterPlan="新的执行卡"
      planDirty onAdoptPlan={adopt} />);
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "载入编辑" })));
    expect(props.onPlanChange).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认为本章计划" })));
    expect(adopt).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "载入编辑" })));
    expect(props.onPlanChange).toHaveBeenCalledWith("新的执行卡");
    view.rerender(<ChapterCreationWorkspace {...props} pendingChapterPlan="新的执行卡"
      onAdoptPlan={adopt} />);
    fireEvent.click(screen.getByRole("button", { name: "确认为本章计划" }));
    expect(adopt).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it("gates extraction until the draft is saved, then opens current-chapter facts inline", () => {
    const state = makeState({ manuscriptTab: "extraction", chapterDirty: true });
    const props = makeProps(state);
    const view = render(<ChapterCreationWorkspace {...props} />);
    expect(screen.getByText("请先保存当前正文，再提取本章知识")).toBeVisible();
    expect(panels.extraction).not.toHaveBeenCalled();
    view.rerender(<ChapterCreationWorkspace {...props} state={{ ...state, chapterDirty: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "转入事实审核" }));
    expect(panels.facts).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: "chapter-1", embedded: true }));
    fireEvent.click(screen.getByRole("button", { name: "查看已保存正文" }));
    expect(state.setManuscriptTab).toHaveBeenCalledWith("manuscript");
  });

  it.each([false, true])("does not replace newer chapter-plan edits after confirmation (adopt=%s)", async (adopt) => {
    window.history.replaceState(null, "", "/writing?assistant=plan");
    const props = { ...makeProps(), pendingChapterPlan: "计划候选", planDirty: true, onAdoptPlan: vi.fn() };
    const view = render(<ConfirmActionProvider><ChapterCreationWorkspace {...props} /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: adopt ? "确认为本章计划" : "载入编辑" }));
    view.rerender(<ConfirmActionProvider><ChapterCreationWorkspace {...props} chapterPlan="新的计划修改" /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: adopt ? "采用计划候选" : "载入计划候选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("计划或候选已变化");
    expect(props.onAdoptPlan).not.toHaveBeenCalled();
    expect(props.onPlanChange).not.toHaveBeenCalled();
  });

  it("does not adopt an old plan candidate after changing chapters during confirmation", async () => {
    window.history.replaceState(null, "", "/writing?assistant=plan");
    const props = { ...makeProps(), pendingChapterPlan: "计划候选", planDirty: true, onAdoptPlan: vi.fn() };
    const view = render(<ConfirmActionProvider><ChapterCreationWorkspace {...props} /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "确认为本章计划" }));
    view.rerender(<ConfirmActionProvider><ChapterCreationWorkspace {...props} chapter={{ ...props.chapter, id: "chapter-2" }} /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "采用计划候选" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(props.onAdoptPlan).not.toHaveBeenCalled();
  });

  it("respects disabled checks without disabling manual saves", () => {
    const state = makeState({ chapterDirty: true });
    const props = makeProps(state);
    const auditFlow = { admission: false, manuscript: false, knowledge: false };
    const view = render(<ChapterCreationWorkspace {...props} auditFlow={auditFlow} />);
    expect(screen.queryByRole("button", { name: "检查正文" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.click(screen.getByRole("tab", { name: "检查" }));
    expect(screen.getByText("此类检查已关闭。")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存正文" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存正文" }));
    expect(state.saveDraft).toHaveBeenCalledOnce();
    view.rerender(<ChapterCreationWorkspace {...props} auditFlow={auditFlow}
      state={{ ...state, manuscriptTab: "extraction" }} />);
    fireEvent.click(screen.getByRole("button", { name: "事实审核" }));
    expect(screen.getByText("知识审核已关闭。")).toBeVisible();
    expect(panels.facts).not.toHaveBeenCalled();
  });

  it("shows read errors and blocks duplicate saves while saving", () => {
    const state = makeState({ chapterDirty: true, savingDraft: true });
    const props = makeProps(state);
    const view = render(<ChapterCreationWorkspace {...props} />);
    expect(screen.getByRole("button", { name: "保存正文" })).toBeDisabled();
    view.rerender(<ChapterCreationWorkspace {...props} state={makeState({
      draftReady: false,
      manuscript: { isSuccess: false, isPending: false, isError: true, error: new Error("读取失败") } as ManuscriptState["manuscript"],
    })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("读取失败");
    expect(screen.queryByText("共享编辑器")).not.toBeInTheDocument();
  });

  it("retains recovery and memory refresh commands", () => {
    const state = makeState({ manuscriptTab: "versions", manuscriptMemoryNeedsRefresh: true });
    render(<ChapterCreationWorkspace {...makeProps(state)} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect(state.recoverLatest).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "更新章节记忆" }));
    expect(state.refreshChapterMemory).toHaveBeenCalledOnce();
  });

  it("keeps extraction edits when opening facts, viewing the manuscript, or dirtying the document", () => {
    const pending = vi.fn();
    const props = makeProps(makeState({ manuscriptTab: "extraction" }));
    const view = render(<ChapterCreationWorkspace {...props} onPendingChange={pending} />);
    fireEvent.change(screen.getByLabelText("提取编辑"), { target: { value: "还未保存的第二条候选" } });
    expect(pending).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "转入事实审核" }));
    expect(screen.getByLabelText("提取编辑")).not.toBeVisible();
    expect(panels.extraction).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    fireEvent.click(screen.getByRole("button", { name: "提取候选" }));
    expect(screen.getByLabelText("提取编辑")).toHaveValue("还未保存的第二条候选");
    view.rerender(<ChapterCreationWorkspace {...props} onPendingChange={pending} state={{ ...props.state, manuscriptTab: "candidate", chapterDirty: true }} />);
    expect(screen.getByLabelText("提取编辑")).not.toBeVisible();
    expect(panels.extraction).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    expect(pending).toHaveBeenLastCalledWith(true);
    view.rerender(<ChapterCreationWorkspace {...props} onPendingChange={pending} />);
    expect(screen.getByLabelText("提取编辑")).toHaveValue("还未保存的第二条候选");
    expect(panels.extraction).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });

  it("deactivates collapsed AI and lazily mounts readiness and review purposes", () => {
    render(<ChapterCreationWorkspace {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.click(screen.getByRole("button", { name: "收起写作助手" }));
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "create", active: false }));
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    expect(panels.ai.mock.calls.some(([props]) => props.mode === "readiness")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "检查" }));
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "review", reviewPurpose: "manuscript", active: true }));
    fireEvent.change(screen.getByLabelText("检查对象"), { target: { value: "admission" } });
    expect(panels.ai.mock.calls.some(([props]) => props.mode === "review" && props.reviewPurpose === "manuscript" && props.active === false)).toBe(true);
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "review", reviewPurpose: "admission", active: true }));
  });

  it("remembers the docked assistant and preserves its input and preference through focus mode", () => {
    const props = makeProps();
    const view = render(<ChapterCreationWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "展开写作助手" }));
    fireEvent.change(screen.getByLabelText("AI 补充意见"), { target: { value: "保留人物动机" } });
    fireEvent.click(screen.getByLabelText("写作显示设置"));
    fireEvent.click(screen.getByRole("button", { name: "进入专注模式" }));
    expect(document.querySelector(".creation-workspace")).toHaveAttribute("data-focus", "true");
    expect(screen.getByLabelText("AI 补充意见")).not.toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".creation-workspace")).toHaveAttribute("data-focus", "false");
    expect(screen.getByLabelText("AI 补充意见")).toHaveValue("保留人物动机");
    view.unmount();
    render(<ChapterCreationWorkspace {...props} />);
    expect(screen.getByRole("button", { name: "收起写作助手" })).toBeVisible();
  });

  it("honors an assistant deep link over a previously collapsed layout", () => {
    localStorage.setItem("ainoveltools:workspace-preferences:v1", JSON.stringify({ layouts: { "writing:assistant": false } }));
    window.history.replaceState(null, "", "/writing?assistant=plan");
    render(<ChapterCreationWorkspace {...makeProps()} />);
    expect(screen.getByRole("textbox", { name: "本章计划" })).toBeVisible();
  });

  it("applies reading preferences and does not exit focus while a modal is open", () => {
    localStorage.setItem("ainoveltools:workspace-preferences:v1", JSON.stringify({ fontSize: 20, lineHeight: 2.2, readingWidth: 680 }));
    render(<ChapterCreationWorkspace {...makeProps()} />);
    const workspace = document.querySelector(".creation-workspace")!;
    expect(workspace).toHaveStyle({ "--writing-font-size": "20px", "--writing-line-height": "2.2", "--writing-width": "680px" });
    fireEvent.click(screen.getByLabelText("写作显示设置"));
    fireEvent.click(screen.getByRole("button", { name: "进入专注模式" }));
    const modal = document.createElement("dialog");
    modal.open = true;
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(workspace).toHaveAttribute("data-focus", "true");
    modal.remove();
    fireEvent.click(screen.getByRole("button", { name: "退出专注模式" }));
    expect(workspace).toHaveAttribute("data-focus", "false");
  });
});
