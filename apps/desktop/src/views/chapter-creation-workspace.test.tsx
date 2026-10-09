import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterCreationWorkspace } from "./chapter-creation-workspace";

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
  beforeEach(() => vi.clearAllMocks());

  it("opens the editor by default and shares the live draft and editor with both review purposes", () => {
    const state = makeState({ chapterDirty: true, draft: doc("最新修改") });
    render(<ChapterCreationWorkspace {...makeProps(state)} />);
    expect(screen.getByText("共享编辑器")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存正文" })).toBeEnabled();
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
    expect(screen.getByLabelText("章节执行卡")).toBeVisible();
  });

  it("preserves AI input through assistant tabs and collapsing the assistant", () => {
    render(<ChapterCreationWorkspace {...makeProps()} />);
    fireEvent.change(screen.getByLabelText("AI 补充意见"), { target: { value: "保持克制" } });
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    fireEvent.click(screen.getByRole("tab", { name: "AI 创作" }));
    expect(screen.getByLabelText("AI 补充意见")).toHaveValue("保持克制");
    fireEvent.click(screen.getByRole("button", { name: "收起创作助手" }));
    expect(screen.getByLabelText("AI 补充意见")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开创作助手" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    fireEvent.change(screen.getByLabelText("章节执行卡"), { target: { value: "在城门发生冲突" } });
    fireEvent.click(screen.getByRole("tab", { name: "AI 创作" }));
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    expect(screen.getByLabelText("章节执行卡")).toHaveValue("在城门发生冲突");
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    expect(savePlan).toHaveBeenCalledOnce();
    expect(screen.getByText("共享编辑器")).toBeVisible();
  });

  it("retains pending execution cards and confirms before replacing plan edits", () => {
    const props = makeProps();
    const adopt = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(<ChapterCreationWorkspace {...props} pendingChapterPlan="新的执行卡"
      planDirty onAdoptPlan={adopt} />);
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    fireEvent.click(screen.getByRole("button", { name: "载入编辑" }));
    expect(props.onPlanChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "采用执行卡" }));
    expect(adopt).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "载入编辑" }));
    expect(props.onPlanChange).toHaveBeenCalledWith("新的执行卡");
    view.rerender(<ChapterCreationWorkspace {...props} pendingChapterPlan="新的执行卡"
      onAdoptPlan={adopt} />);
    fireEvent.click(screen.getByRole("button", { name: "采用执行卡" }));
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

  it("respects disabled checks without disabling manual saves", () => {
    const state = makeState({ chapterDirty: true });
    const props = makeProps(state);
    const auditFlow = { admission: false, manuscript: false, knowledge: false };
    const view = render(<ChapterCreationWorkspace {...props} auditFlow={auditFlow} />);
    expect(screen.queryByRole("button", { name: "检查正文" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "收起创作助手" }));
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
    fireEvent.click(screen.getByRole("button", { name: "收起创作助手" }));
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "create", active: false }));
    fireEvent.click(screen.getByRole("button", { name: "展开创作助手" }));
    fireEvent.click(screen.getByRole("tab", { name: "本章计划" }));
    expect(panels.ai.mock.calls.some(([props]) => props.mode === "readiness")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "检查" }));
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "review", reviewPurpose: "manuscript", active: true }));
    fireEvent.change(screen.getByLabelText("检查对象"), { target: { value: "admission" } });
    expect(panels.ai.mock.calls.some(([props]) => props.mode === "review" && props.reviewPurpose === "manuscript" && props.active === false)).toBe(true);
    expect(panels.ai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "review", reviewPurpose: "admission", active: true }));
  });
});
