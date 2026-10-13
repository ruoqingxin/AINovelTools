import { BookOpenText, ClipboardList, History, Library, MoreHorizontal, PanelRightClose, PanelRightOpen, RefreshCw, Save, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AuditFlowSettings, PlanNode } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";
import { ChapterExtractionPanel } from "./chapter-extraction-panel";
import { KnowledgeReviewView } from "./knowledge-review-view";
import { ManuscriptCandidateEditor } from "./manuscript-candidate-editor";
import { ManuscriptReader } from "./manuscript-reader";
import { ManuscriptVersionsPanel } from "./manuscript-versions-panel";
import { documentCharacterCount, documentToText, formatSavedAt } from "./project-workspace-utils";
import type { useChapterManuscript } from "./use-chapter-manuscript";
import { WorkspaceTabs } from "./workspace-tabs";
import "./chapter-creation-workspace.css";
import { PlanningDiscussionSources } from "./planning-discussion-sources";
import { ChapterEntityReferencePanel } from "./chapter-entity-references";
import { sourceReturnTo } from "../lib/manuscript-source";
import { useWideWorkspace, WorkspacePanel } from "./workspace-panel";

type AssistantTab = "ai" | "plan" | "review";

const assistantTabs = [
  { value: "ai", label: "AI 写作", icon: Sparkles },
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
  planReady = true,
  onPlanChange,
  onSavePlan,
  onAdoptPlan,
  auditFlow,
  state,
  onPendingChange,
}: {
  chapter: PlanNode;
  volume?: PlanNode;
  chapterPlan: string;
  pendingChapterPlan?: string;
  volumePlan: string;
  planDirty: boolean;
  savingPlan: boolean;
  planReady?: boolean;
  onPlanChange: (value: string) => void;
  onSavePlan: () => Promise<void>;
  onAdoptPlan?: () => Promise<void>;
  auditFlow?: AuditFlowSettings;
  state: ReturnType<typeof useChapterManuscript>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [assistantTab, setAssistantTab] = useState<AssistantTab>(() =>
    new URLSearchParams(window.location.search).get("assistant") === "plan" ? "plan"
      : new URLSearchParams(window.location.search).get("assistant") === "review" ? "review" : "ai");
  const [visitedAssistantTabs, setVisitedAssistantTabs] = useState<AssistantTab[]>([assistantTab]);
  const [assistantOpen, setAssistantOpen] = useState(() =>
    ["plan", "ai", "review"].includes(new URLSearchParams(window.location.search).get("assistant") ?? ""));
  const assistantDocked = useWideWorkspace(1280);
  const [reviewPurpose, setReviewPurpose] = useState<"admission" | "manuscript">(() =>
    new URLSearchParams(window.location.search).get("purpose") === "admission" ? "admission" : "manuscript");
  const [knowledgeTab, setKnowledgeTab] = useState<"extraction" | "facts">(() =>
    new URLSearchParams(window.location.search).get("knowledge") === "facts" ? "facts" : "extraction");
  const [visitedReviews, setVisitedReviews] = useState<Array<"admission" | "manuscript">>(assistantTab === "review" ? [reviewPurpose] : []);
  const [extractionVisited, setExtractionVisited] = useState(false);
  const [factsVisited, setFactsVisited] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [pendingPanels, setPendingPanels] = useState<Record<string, boolean>>({});
  const pendingCallbacks = useMemo(() => Object.fromEntries(
    ["ai", "extraction", "facts", "admission", "manuscript", "references"].map((key) => [key, (pending: boolean) => {
      setPendingPanels((current) => current[key] === pending ? current : { ...current, [key]: pending });
    }]),
  ), []);
  const candidatePending = Object.values(pendingPanels).some(Boolean);
  const referenceReturn = sourceReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
  useEffect(() => { onPendingChange?.(candidatePending); }, [candidatePending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  const hasDraft = Boolean(documentToText(state.draft).trim());
  const reviewEnabled = auditFlow?.[reviewPurpose] !== false;
  const knowledgeActive = state.manuscriptTab === "extraction";
  const extractionAvailable = state.draftReady && Boolean(state.manuscript.data) && !state.chapterDirty;
  useEffect(() => {
    if (knowledgeActive && knowledgeTab === "extraction" && extractionAvailable) setExtractionVisited(true);
    if (knowledgeActive && knowledgeTab === "facts") setFactsVisited(true);
  }, [knowledgeActive, knowledgeTab, extractionAvailable]);

  function selectAssistantTab(tab: AssistantTab) {
    setAssistantTab(tab);
    setVisitedAssistantTabs((tabs) => tabs.includes(tab) ? tabs : [...tabs, tab]);
    if (tab === "review") setVisitedReviews((items) => items.includes(reviewPurpose) ? items : [...items, reviewPurpose]);
  }

  function openReview(purpose: "admission" | "manuscript") {
    setReviewPurpose(purpose);
    setVisitedReviews((items) => items.includes(purpose) ? items : [...items, purpose]);
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
    onOpenChapterPlan: () => { selectAssistantTab("plan"); setAssistantOpen(true); },
  };

  return <div className="creation-workspace" data-assistant-open={assistantOpen}>
    <div className="creation-main">
      {referenceReturn && assistantTab !== "plan" ? <a className="activity-return" href={referenceReturn}>返回来源</a> : null}
      <div className="creation-navigation">
        <div className="creation-mode" role="group" aria-label="正文模式">
          <button type="button" aria-pressed={state.manuscriptTab !== "manuscript"}
            onClick={() => state.setManuscriptTab("candidate")}>编辑</button>
          <button type="button" aria-pressed={state.manuscriptTab === "manuscript"}
            onClick={() => state.setManuscriptTab("manuscript")}>阅读</button>
        </div>
        <div className="creation-local-tools">
          <button type="button" className="icon-command" title="历史版本" aria-label="历史版本"
            onClick={() => state.setManuscriptTab("versions")}><History size={17} />
            {state.recovery.data?.length ? <span className="tool-count">{state.recovery.data.length}</span> : null}</button>
          <button type="button" className="icon-command" title="本章知识" aria-label="本章知识"
            onClick={() => state.setManuscriptTab("extraction")}><Library size={17} /></button>
        <button type="button" className="icon-command" title={assistantOpen ? "收起写作助手" : "展开写作助手"}
          aria-label={assistantOpen ? "收起写作助手" : "展开写作助手"} aria-expanded={assistantOpen}
          onClick={() => setAssistantOpen((open) => !open)}>
          {assistantOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </button>
        </div>
      </div>
      {state.manuscript.isError ? <p className="project-error" role="alert">无法读取正文：{state.manuscript.error.message}</p> : null}
      {state.manuscript.isPending ? <p className="plan-empty" role="status">正在加载正文…</p> : null}
      {state.localDraft.isPending && state.manuscript.isSuccess ? <p className="plan-empty" role="status">正在读取本地草稿…</p> : null}
      {state.localDraft.isError || state.draftStorageError ? <div className="creation-memory-status" role="alert">
        <span>{state.draftStorageError ?? `无法读取本地草稿：${state.localDraft.error?.message}`}</span>
        {state.draftStorageError ? <button type="button" className="secondary-action"
          onClick={() => void state.persistLocalDraft()} disabled={state.savingLocalDraft}>重试保存草稿</button> : null}
        <button type="button" className="secondary-action" onClick={() => void state.reloadLocalDraft()} disabled={state.savingDraft}>
          {state.draftReady ? "保留副本并重读" : "重新读取草稿"}</button>
      </div> : null}
      {state.manuscriptMemoryNeedsRefresh && (!assistantOpen || assistantTab !== "ai") ? <div className="creation-memory-status" role="status">
        <span>章节记忆待更新</span>
        <button type="button" className="secondary-action" onClick={() => void state.refreshChapterMemory()}
          disabled={state.refreshingChapterMemory}><RefreshCw size={14} />{state.refreshingChapterMemory ? "提交中…" : "更新章节记忆"}</button>
      </div> : null}
      {state.draftReady && state.manuscriptTab !== "manuscript" ? <div
        className="creation-edit-panel" id="manuscript-panel-candidate" role="region" aria-label="正文编辑">
        <div className="creation-document-heading">
          <h3>正文编辑</h3>
          <span>{documentCharacterCount(state.draft)} 字</span>
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
          <span>{state.savingDraft ? "正在保存正文…" : state.savingLocalDraft ? "正在保存草稿…"
            : state.draftStorageError ? "草稿保护失败" : state.draftNeedsPersistence ? "草稿保护中"
            : state.chapterDirty ? "草稿已保护 · 正文待保存" : state.manuscript.data ? "正文已保存" : "尚未保存正文"}</span>
          <div>
            {state.chapterDirty ? <details className="creation-more"><summary title="更多正文操作" aria-label="更多正文操作"><MoreHorizontal size={17} /></summary>
              <div><button type="button" onClick={() => void state.discardLocalDraft()} disabled={state.savingDraft}>放弃草稿</button>
                {state.manuscript.data ? <button type="button" onClick={() => void state.mergeDraft()} disabled={state.savingDraft}>检查冲突</button> : null}</div>
            </details> : null}
            {auditFlow?.manuscript !== false ? <button type="button" className="secondary-action"
              onClick={() => openReview("manuscript")} disabled={!hasDraft}><ShieldCheck size={14} />检查正文</button> : null}
            <button type="button" className="primary-action" onClick={() => void state.saveDraft()}
              disabled={state.savingDraft || !state.chapterDirty || (!hasDraft && !state.manuscript.data)}><Save size={14} />保存正文</button>
          </div>
        </div>
      </div> : null}
      {state.manuscript.isSuccess && state.manuscriptTab === "manuscript" ? <div
        className="creation-reader-panel" id="manuscript-panel-manuscript" role="region" aria-label="已保存正文">
        <div className="creation-document-heading"><h3>已保存正文</h3>
          <span>{state.manuscript.data ? formatSavedAt(state.manuscript.data.createdAt) : "尚无版本"}</span>
        </div>
        {state.manuscript.data ? <ManuscriptReader documentJson={state.manuscript.data.documentJson} /> : <div className="creation-empty">
          <BookOpenText size={24} /><p>本章尚无已保存正文</p>
          <button type="button" className="primary-action" onClick={() => state.setManuscriptTab("candidate")}>开始写作</button>
        </div>}
      </div> : null}
      <WorkspacePanel open={state.manuscriptTab === "versions"} title="历史版本" onClose={() => state.setManuscriptTab("candidate")}>
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
      </WorkspacePanel>
      <WorkspacePanel open={knowledgeActive} title="本章知识" onClose={() => state.setManuscriptTab("candidate")}>
      {knowledgeActive || extractionVisited || factsVisited ? <div className="creation-knowledge-panel" hidden={!knowledgeActive}
        id="manuscript-panel-extraction" role="region" aria-label="本章知识内容">
        <div className="creation-knowledge-switch" role="group" aria-label="本章知识">
          <button type="button" aria-pressed={knowledgeTab === "extraction"} onClick={() => setKnowledgeTab("extraction")}>提取候选</button>
          <button type="button" aria-pressed={knowledgeTab === "facts"} onClick={() => setKnowledgeTab("facts")}>事实审核</button>
        </div>
        <div hidden={knowledgeTab !== "extraction" || !extractionAvailable}>
        {extractionVisited || (knowledgeActive && knowledgeTab === "extraction" && extractionAvailable) ? <ChapterExtractionPanel
          active={knowledgeActive && knowledgeTab === "extraction" && extractionAvailable}
          onPendingChange={pendingCallbacks.extraction}
          chapterId={chapter.id} onOpenFactReview={() => setKnowledgeTab("facts")}
          onOpenManuscript={() => state.setManuscriptTab("manuscript")} /> : null}
        </div>
        {knowledgeTab === "extraction" && !extractionAvailable ? <div className="creation-empty">
          <p>{state.chapterDirty ? "请先保存当前正文，再提取本章知识" : "保存正文后即可提取本章知识"}</p>
          <button type="button" className="primary-action" onClick={() => state.setManuscriptTab("candidate")}>返回编辑</button>
        </div> : null}
        <div hidden={knowledgeTab !== "facts"}>
        {(factsVisited || (knowledgeActive && knowledgeTab === "facts")) && auditFlow?.knowledge !== false ? <KnowledgeReviewView embedded chapterId={chapter.id}
          active={knowledgeActive && knowledgeTab === "facts"} onPendingChange={pendingCallbacks.facts}
          onOpenManuscript={() => state.setManuscriptTab("manuscript")} /> : knowledgeTab === "facts" && auditFlow?.knowledge === false ? <p className="plan-empty">
          知识审核已关闭。<a href="/settings#writing-admission">审核设置</a>
        </p> : null}
        </div>
      </div> : null}
      </WorkspacePanel>
    </div>
    <WorkspacePanel open={assistantOpen} docked={assistantDocked} title="写作助手" className="creation-assistant"
      onClose={() => setAssistantOpen(false)}>
      <WorkspaceTabs prefix="assistant" label="写作助手页签" value={assistantTab} tabs={assistantTabs} onChange={selectAssistantTab} />
      <div id="assistant-panel-ai" role="tabpanel" aria-labelledby="assistant-tab-ai" hidden={assistantTab !== "ai"}>
        {state.draftReady ? <AiWritingPanel {...aiProps}
          active={assistantOpen && assistantTab === "ai"} onPendingChange={pendingCallbacks.ai}
          mode="create" onOpenAdmissionReview={() => openReview("admission")} /> : <p className="plan-empty">等待正文就绪…</p>}
      </div>
      <div id="assistant-panel-plan" role="tabpanel" aria-labelledby="assistant-tab-plan" hidden={assistantTab !== "plan"}>
        {visitedAssistantTabs.includes("plan") ? <div className="creation-plan">
          {volume ? <details><summary>{volume.title}</summary><p>{volumePlan.trim() || "尚未填写分卷规划"}</p></details> : null}
          <label htmlFor="creation-chapter-plan">本章计划</label>
          <textarea id="creation-chapter-plan" disabled={!planReady} rows={12} value={chapterPlan} onChange={(event) => onPlanChange(event.target.value)}
            placeholder="本章想写的情境、事件或接下来的一步…" />
          <button type="button" className="primary-action" onClick={() => void onSavePlan()}
            disabled={!planReady || savingPlan || !planDirty || !chapterPlan.trim()}><Save size={14} />{savingPlan ? "保存中…" : "保存计划"}</button>
          {pendingChapterPlan?.trim() ? <div className="creation-plan-candidate">
            <strong>计划候选</strong>
            <pre>{pendingChapterPlan}</pre>
            <div>
              <button type="button" className="secondary-action" onClick={() => {
                if (planDirty && !window.confirm("当前章节计划有未保存修改。载入候选会替换这些修改，确定继续吗？")) return;
                onPlanChange(pendingChapterPlan);
              }} disabled={savingPlan}>载入编辑</button>
              {onAdoptPlan ? <button type="button" className="primary-action" onClick={() => {
                if (planDirty && !window.confirm("当前章节计划有未保存修改。采用候选会替换这些修改，确定继续吗？")) return;
                void onAdoptPlan();
              }} disabled={savingPlan}>确认为本章计划</button> : null}
            </div>
          </div> : null}
          <a href="/planning">全书大纲</a>
          {referenceReturn ? <a href={referenceReturn}>返回来源</a> : null}
          <ChapterEntityReferencePanel chapterId={chapter.id} active={assistantOpen && assistantTab === "plan"}
            onPendingChange={pendingCallbacks.references} />
          <PlanningDiscussionSources sectionId={`plan-node:${chapter.id}`} active={assistantOpen && assistantTab === "plan"}
            returnTo={`/writing?assistant=plan#${encodeURIComponent(chapter.id)}`} />
          <details onToggle={(event) => setReadinessOpen(event.currentTarget.open)}>
            <summary>生成前检查</summary>
            {readinessOpen ? <AiWritingPanel {...aiProps} mode="readiness" active={assistantOpen && assistantTab === "plan"} /> : null}
          </details>
        </div> : null}
      </div>
      <div id="assistant-panel-review" role="tabpanel" aria-labelledby="assistant-tab-review" hidden={assistantTab !== "review"}>
        {visitedAssistantTabs.includes("review") ? <>
          <label className="creation-review-purpose">检查对象
            <select value={reviewPurpose} onChange={(event) => {
              const purpose = event.target.value as "admission" | "manuscript";
              setReviewPurpose(purpose);
              setVisitedReviews((items) => items.includes(purpose) ? items : [...items, purpose]);
            }}>
              <option value="manuscript">当前正文草稿</option><option value="admission">生成前检查</option>
            </select>
          </label>
          {!reviewEnabled ? <p className="plan-empty">此类检查已关闭。<a href="/settings#writing-admission">审核设置</a></p> : null}
          {state.draftReady ? visitedReviews.map((purpose) => <div key={purpose} hidden={reviewPurpose !== purpose || auditFlow?.[purpose] === false}>
            <AiWritingPanel {...aiProps} mode="review" reviewPurpose={purpose}
              active={assistantOpen && assistantTab === "review" && reviewPurpose === purpose && auditFlow?.[purpose] !== false}
              onPendingChange={pendingCallbacks[purpose]} />
          </div>) : <p className="plan-empty">等待正文就绪…</p>}
        </> : null}
      </div>
    </WorkspacePanel>
  </div>;
}
