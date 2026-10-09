import { BookOpenText, ClipboardList, PanelRightClose, PanelRightOpen, RefreshCw, Save, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import type { AuditFlowSettings, PlanNode } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";
import { ChapterExtractionPanel } from "./chapter-extraction-panel";
import { KnowledgeReviewView } from "./knowledge-review-view";
import { ManuscriptCandidateEditor } from "./manuscript-candidate-editor";
import { ManuscriptReader } from "./manuscript-reader";
import { ManuscriptVersionsPanel } from "./manuscript-versions-panel";
import { ManuscriptWorkspaceTabs } from "./manuscript-workspace-tabs";
import { documentCharacterCount, documentToText, formatSavedAt } from "./project-workspace-utils";
import type { useChapterManuscript } from "./use-chapter-manuscript";
import { WorkspaceTabs } from "./workspace-tabs";
import "./chapter-creation-workspace.css";

type AssistantTab = "ai" | "plan" | "review";

const assistantTabs = [
  { value: "ai", label: "AI 创作", icon: Sparkles },
  { value: "plan", label: "本章计划", icon: ClipboardList },
  { value: "review", label: "检查", icon: ShieldCheck },
] as const;

export function ChapterCreationWorkspace({
  chapter,
  volume,
  chapterPlan,
  pendingChapterPlan,
  volumePlan,
  planDirty,
  savingPlan,
  onPlanChange,
  onSavePlan,
  onAdoptPlan,
  auditFlow,
  state,
}: {
  chapter: PlanNode;
  volume?: PlanNode;
  chapterPlan: string;
  pendingChapterPlan?: string;
  volumePlan: string;
  planDirty: boolean;
  savingPlan: boolean;
  onPlanChange: (value: string) => void;
  onSavePlan: () => Promise<void>;
  onAdoptPlan?: () => Promise<void>;
  auditFlow?: AuditFlowSettings;
  state: ReturnType<typeof useChapterManuscript>;
}) {
  const [assistantTab, setAssistantTab] = useState<AssistantTab>("ai");
  const [visitedAssistantTabs, setVisitedAssistantTabs] = useState<AssistantTab[]>(["ai"]);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [reviewPurpose, setReviewPurpose] = useState<"admission" | "manuscript">("manuscript");
  const [knowledgeTab, setKnowledgeTab] = useState<"extraction" | "facts">("extraction");
  const hasDraft = Boolean(documentToText(state.draft).trim());
  const reviewEnabled = auditFlow?.[reviewPurpose] !== false;

  function selectAssistantTab(tab: AssistantTab) {
    setAssistantTab(tab);
    setVisitedAssistantTabs((tabs) => tabs.includes(tab) ? tabs : [...tabs, tab]);
  }

  function openReview(purpose: "admission" | "manuscript") {
    setReviewPurpose(purpose);
    selectAssistantTab("review");
    setAssistantOpen(true);
  }

  const aiProps = {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterPlan,
    volumeId: volume?.id ?? "",
    volumePlan,
    draft: state.draft,
    editor: state.editor,
    onReturnToEditor: () => state.setManuscriptTab("candidate"),
    onOpenChapterPlan: () => selectAssistantTab("plan"),
  };

  return <div className="creation-workspace" data-assistant-open={assistantOpen}>
    <div className="creation-main">
      <div className="creation-navigation">
        <ManuscriptWorkspaceTabs
          value={state.manuscriptTab}
          onChange={state.setManuscriptTab}
          recoveryCount={state.recovery.data?.length ?? 0}
          candidateDirty={state.chapterDirty}
        />
        <button type="button" className="icon-command" title={assistantOpen ? "收起创作助手" : "展开创作助手"}
          aria-label={assistantOpen ? "收起创作助手" : "展开创作助手"} aria-expanded={assistantOpen}
          onClick={() => setAssistantOpen((open) => !open)}>
          {assistantOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </button>
      </div>
      {state.manuscript.isError ? <p className="project-error" role="alert">无法读取正文：{state.manuscript.error.message}</p> : null}
      {state.manuscript.isPending ? <p className="plan-empty" role="status">正在加载正文…</p> : null}
      {state.manuscriptMemoryNeedsRefresh && (!assistantOpen || assistantTab !== "ai") ? <div className="creation-memory-status" role="status">
        <span>章节记忆待更新</span>
        <button type="button" className="secondary-action" onClick={() => void state.refreshChapterMemory()}
          disabled={state.refreshingChapterMemory}><RefreshCw size={14} />{state.refreshingChapterMemory ? "提交中…" : "更新章节记忆"}</button>
      </div> : null}
      {state.manuscript.isSuccess && state.manuscriptTab === "candidate" ? <div
        className="creation-edit-panel" id="manuscript-panel-candidate" role="tabpanel" aria-labelledby="manuscript-tab-candidate">
        <div className="creation-document-heading">
          <h3>正文编辑</h3>
          <span>{documentCharacterCount(state.draft)} 字 · {state.chapterDirty ? "未保存" : state.manuscript.data ? "已保存" : "新章节"}</span>
        </div>
        {state.editor ? <ManuscriptCandidateEditor editor={state.editor} /> : <p className="plan-empty">正在加载编辑器…</p>}
        {state.mergeResult ? <div className="merge-panel" role="status">
          <strong>{state.mergeResult.conflicts.length ? `发现 ${state.mergeResult.conflicts.length} 个冲突块` : "没有发现冲突"}</strong>
          {!state.mergeResult.conflicts.length ? <button type="button" className="secondary-action"
            onClick={() => state.loadCandidate(state.mergeResult!.documentJson)}>应用合并结果</button> : null}
          {state.mergeResult.conflicts.map((conflict) => <p key={conflict.blockId}>
            <code>{conflict.blockId}</code> · 请在正文中确认冲突内容。
          </p>)}
        </div> : null}
        <div className="creation-savebar">
          <span>{state.savingDraft ? "保存中…" : state.chapterDirty ? "有内容待保存" : "无待保存修改"}</span>
          <div>
            {state.chapterDirty && state.manuscript.data ? <button type="button" className="secondary-action"
              onClick={() => void state.mergeDraft()} disabled={state.savingDraft}>检查冲突</button> : null}
            {auditFlow?.manuscript !== false ? <button type="button" className="secondary-action"
              onClick={() => openReview("manuscript")} disabled={!hasDraft}><ShieldCheck size={14} />检查正文</button> : null}
            <button type="button" className="primary-action" onClick={() => void state.saveDraft()}
              disabled={state.savingDraft || !state.chapterDirty || (!hasDraft && !state.manuscript.data)}><Save size={14} />保存正文</button>
          </div>
        </div>
      </div> : null}
      {state.manuscript.isSuccess && state.manuscriptTab === "manuscript" ? <div
        className="creation-reader-panel" id="manuscript-panel-manuscript" role="tabpanel" aria-labelledby="manuscript-tab-manuscript">
        <div className="creation-document-heading"><h3>已保存正文</h3>
          <span>{state.manuscript.data ? formatSavedAt(state.manuscript.data.createdAt) : "尚无版本"}</span>
        </div>
        {state.manuscript.data ? <ManuscriptReader documentJson={state.manuscript.data.documentJson} /> : <div className="creation-empty">
          <BookOpenText size={24} /><p>本章尚无已保存正文</p>
          <button type="button" className="primary-action" onClick={() => state.setManuscriptTab("candidate")}>开始写作</button>
        </div>}
      </div> : null}
      {state.manuscriptTab === "versions" ? <>
        {state.history.isPending ? <p className="plan-empty" role="status">正在加载版本…</p> : null}
        {state.history.isError ? <p className="project-error" role="alert">{state.history.error.message}</p> : null}
        {state.history.isSuccess ? <ManuscriptVersionsPanel
          clearingRecovery={state.clearingRecovery}
          compareLeftId={state.compareLeftId}
          compareRightId={state.compareRightId}
          history={state.history.data}
          onCompareLeftChange={state.setCompareLeftId}
          onCompareRightChange={state.setCompareRightId}
          onDiscardRecovery={state.discardRecoveryLogs}
          onRecoverLatest={state.recoverLatest}
          onRestoreRevision={state.restoreRevision}
          recovery={state.recovery.data ?? []}
        /> : null}
      </> : null}
      {state.manuscriptTab === "extraction" ? <div className="creation-knowledge-panel"
        id="manuscript-panel-extraction" role="tabpanel" aria-labelledby="manuscript-tab-extraction">
        <div className="creation-knowledge-switch" role="group" aria-label="本章知识">
          <button type="button" aria-pressed={knowledgeTab === "extraction"} onClick={() => setKnowledgeTab("extraction")}>提取候选</button>
          <button type="button" aria-pressed={knowledgeTab === "facts"} onClick={() => setKnowledgeTab("facts")}>事实审核</button>
        </div>
        {knowledgeTab === "extraction" ? state.manuscript.data && !state.chapterDirty ? <ChapterExtractionPanel
          chapterId={chapter.id} onOpenFactReview={() => setKnowledgeTab("facts")}
          onOpenManuscript={() => state.setManuscriptTab("manuscript")} /> : <div className="creation-empty">
          <p>{state.chapterDirty ? "请先保存当前正文，再提取本章知识" : "保存正文后即可提取本章知识"}</p>
          <button type="button" className="primary-action" onClick={() => state.setManuscriptTab("candidate")}>返回编辑</button>
        </div> : auditFlow?.knowledge !== false ? <KnowledgeReviewView embedded chapterId={chapter.id}
          onOpenManuscript={() => state.setManuscriptTab("manuscript")} /> : <p className="plan-empty">
          知识审核已关闭。<a href="/settings#writing-admission">审核设置</a>
        </p>}
      </div> : null}
    </div>
    <aside className="creation-assistant" aria-label="创作助手" hidden={!assistantOpen}>
      <WorkspaceTabs prefix="assistant" label="创作助手页签" value={assistantTab} tabs={assistantTabs} onChange={selectAssistantTab} />
      <div id="assistant-panel-ai" role="tabpanel" aria-labelledby="assistant-tab-ai" hidden={assistantTab !== "ai"}>
        {state.manuscript.isSuccess ? <AiWritingPanel {...aiProps}
          mode="create" onOpenAdmissionReview={() => openReview("admission")} /> : <p className="plan-empty">等待正文就绪…</p>}
      </div>
      <div id="assistant-panel-plan" role="tabpanel" aria-labelledby="assistant-tab-plan" hidden={assistantTab !== "plan"}>
        {visitedAssistantTabs.includes("plan") ? <div className="creation-plan">
          {volume ? <details><summary>{volume.title}</summary><p>{volumePlan.trim() || "尚未填写分卷规划"}</p></details> : null}
          <label htmlFor="creation-chapter-plan">章节执行卡</label>
          <textarea id="creation-chapter-plan" rows={12} value={chapterPlan} onChange={(event) => onPlanChange(event.target.value)}
            placeholder="本章目标、冲突、关键行动和结尾钩子" />
          <button type="button" className="primary-action" onClick={() => void onSavePlan()}
            disabled={savingPlan || !planDirty || !chapterPlan.trim()}><Save size={14} />{savingPlan ? "保存中…" : "保存计划"}</button>
          {pendingChapterPlan?.trim() ? <div className="creation-plan-candidate">
            <strong>执行卡候选</strong>
            <pre>{pendingChapterPlan}</pre>
            <div>
              <button type="button" className="secondary-action" onClick={() => {
                if (planDirty && !window.confirm("当前章节计划有未保存修改。载入候选会替换这些修改，确定继续吗？")) return;
                onPlanChange(pendingChapterPlan);
              }} disabled={savingPlan}>载入编辑</button>
              {onAdoptPlan ? <button type="button" className="primary-action" onClick={() => {
                if (planDirty && !window.confirm("当前章节计划有未保存修改。采用候选会替换这些修改，确定继续吗？")) return;
                void onAdoptPlan();
              }} disabled={savingPlan}>采用执行卡</button> : null}
            </div>
          </div> : null}
          <a href="/planning">全书规划</a>
          <details>
            <summary>写作准备</summary>
            <AiWritingPanel {...aiProps} mode="readiness" />
          </details>
        </div> : null}
      </div>
      <div id="assistant-panel-review" role="tabpanel" aria-labelledby="assistant-tab-review" hidden={assistantTab !== "review"}>
        {visitedAssistantTabs.includes("review") ? <>
          <label className="creation-review-purpose">检查对象
            <select value={reviewPurpose} onChange={(event) => setReviewPurpose(event.target.value as "admission" | "manuscript")}>
              <option value="manuscript">当前正文草稿</option><option value="admission">创作准入</option>
            </select>
          </label>
          {!reviewEnabled ? <p className="plan-empty">此类检查已关闭。<a href="/settings#writing-admission">审核设置</a></p>
            : state.manuscript.isSuccess ? <AiWritingPanel {...aiProps} key={reviewPurpose} mode="review" reviewPurpose={reviewPurpose} />
            : <p className="plan-empty">等待正文就绪…</p>}
        </> : null}
      </div>
    </aside>
  </div>;
}
