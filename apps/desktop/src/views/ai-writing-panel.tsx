import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { Ban, Check, ClipboardCheck, Columns2, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import {
  cancelAiTask,
  enqueueChapterSummaryRefresh,
  errorMessage,
  getAuditFlowSettings,
  generateAiProposal,
  getWritingReviewPolicy,
  listAiProposals,
  listEntities,
  listModelProfiles,
  listPlanningSections,
  listSummaryMaterials,
  type AiAction,
  type AiProposalReview,
  type Job,
  type ReviewPurpose,
} from "../lib/tauri-client";
import { useJobs } from "../lib/jobs-query";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { assessWritingReadiness, findWritingGapTargets } from "../lib/writing-readiness";
import { AiModelNote } from "./ai-model-note";
import { WritingReadinessPanel } from "./writing-readiness-panel";
import { useCandidateEditGuard } from "./use-candidate-edits";
import { actionLabels, aiFailureMessage, buildLineDiff, consistencyAdmission, documentHasText } from "./ai-writing-utils";
import { useAiTaskStream } from "./use-ai-task-stream";
import { useAiProposalActions } from "./use-ai-proposal-actions";
import { AiConsistencyReviewList } from "./ai-consistency-review-list";

function isChapterSummaryJobFor(job: Job, chapterId: string) {
  if (job.jobType !== "REFRESH_CHAPTER_SUMMARY") return false;
  try {
    return JSON.parse(job.payload).chapterId === chapterId;
  } catch {
    return false;
  }
}

export type AiWritingPanelMode = "readiness" | "create" | "review";

export function AiWritingPanel(props: { mode?: AiWritingPanelMode; active?: boolean; onPendingChange?: (pending: boolean) => void; reviewPurpose?: "admission" | "manuscript"; chapterId: string; chapterTitle: string; chapterPlan: string; volumeId: string; volumePlan: string; draft: string; editor: Editor | null; onOpenAdmissionReview?: () => void; onReturnToEditor?: () => void; onOpenChapterPlan?: () => void }) {
  const client = useQueryClient();
  const active = props.active !== false;
  const mode = props.mode ?? "create";
  const isReadinessMode = mode === "readiness";
  const isCreationMode = mode === "create";
  const isReviewMode = mode === "review";
  const reviewPurpose: ReviewPurpose = (props.reviewPurpose ?? "admission") === "manuscript" ? "MANUSCRIPT" : "ADMISSION";
  const reviewingManuscript = reviewPurpose === "MANUSCRIPT";
  const panelTaskKey = isReviewMode ? "consistencyReview" : "writing";
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles, enabled: active && !isReadinessMode });
  const aiPreferences = useAiTaskPreferences(active && !isReadinessMode);
  const reviewPolicyQuery = useQuery({ queryKey: ["writing-review-policy"], queryFn: getWritingReviewPolicy, enabled: active && !isReadinessMode });
  const auditFlow = useQuery({ queryKey: ["audit-flow-settings"], queryFn: getAuditFlowSettings, enabled: active && !isReadinessMode });
  const planningSections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections, enabled: active && isReadinessMode });
  const entities = useQuery({ queryKey: ["entities", false], queryFn: () => listEntities(false), enabled: active && isReadinessMode });
  const chapterSummaries = useQuery({ queryKey: ["summary-materials"], queryFn: listSummaryMaterials, enabled: active && isCreationMode });
  const summaryJobs = useJobs({ enabled: active && isCreationMode });
  const [instruction, setInstruction] = useState("");
  const [instructionBaseline, setInstructionBaseline] = useState("");
  const deferredInstruction = useDeferredValue(instruction);
  const currentDocumentJson = reviewingManuscript && props.editor
    ? JSON.stringify(props.editor.getJSON())
    : props.draft || (props.editor ? JSON.stringify(props.editor.getJSON()) : "");
  const deferredDocumentJson = useDeferredValue(currentDocumentJson);
  const proposals = useQuery({
    queryKey: ["ai-proposals", props.chapterId, mode, reviewPurpose, props.chapterPlan, props.volumePlan, deferredDocumentJson, deferredInstruction],
    queryFn: () => listAiProposals({
      ...(isReviewMode ? { reviewPurpose } : {}),
      chapterId: props.chapterId,
      chapterTitle: props.chapterTitle,
      chapterPlan: props.chapterPlan,
      volumePlan: props.volumePlan,
      documentJson: deferredDocumentJson,
      ...(deferredInstruction.trim() ? { instruction: deferredInstruction.trim() } : {}),
    }),
    enabled: active && !isReadinessMode,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { textEdits, partialTexts, feedbackEdits, feedbackNotes, decidingProposalId, feedbackBusyId,
    unappliedCandidate, setUnappliedCandidate, compareIds, proposalAnchors, setProposalAnchors, lastApplied,
    resolveReplacementRange, applyText, undoLastApplied, decide, submitFeedback, toggleCompare,
  } = useAiProposalActions({ chapterId: props.chapterId, editor: props.editor, proposals: proposals.data, onError: setError });
  useCandidateEditGuard(textEdits.dirty || feedbackEdits.dirty || instruction !== instructionBaseline || unappliedCandidate !== null,
    busy || decidingProposalId !== null || feedbackBusyId !== null, props.onPendingChange);
  const { preview, fallbackNotice, setFallbackNotice, generationBusy, generationLocked,
    effectiveTaskId, beginRequest, finishRequest,
  } = useAiTaskStream({ chapterId: props.chapterId, active, enabled: !isReadinessMode, busy, taskKey: panelTaskKey,
    ...(isReviewMode ? { reviewPurpose } : {}) });
  const chapterSummary = (chapterSummaries.data ?? []).find((item) => item.sourceId === props.chapterId && item.generationMode === "EXTRACTIVE_AUTO");
  const chapterSummaryJob = (summaryJobs.data ?? []).find((job) => isChapterSummaryJobFor(job, props.chapterId) && (job.status === "QUEUED" || job.status === "RUNNING"));
  const chapterSummaryStatus = chapterSummaryJob?.status === "RUNNING"
    ? "章节记忆更新中"
    : chapterSummaryJob ? "章节记忆等待更新"
    : chapterSummary?.lifecycleStatus === "ACTIVE" ? "章节记忆最新" : "章节记忆已过期";

  useEffect(() => { setError(null); }, [props.chapterId]);

  async function runAction(action: AiAction) {
    const consistencyCheck = action === "CONSISTENCY_CHECK";
    const taskKey = consistencyCheck ? "consistencyReview" : "writing";
    const chatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, taskKey);
    const chatPreference = resolveTaskPreference(aiPreferences.data, taskKey);
    if (!chatProfile || (!props.editor && !consistencyCheck)) return;
    if ((action === "DRAFT" || action === "CONTINUE") && consistencyBlocked) {
      setError("最近一次创作准入检查存在阻断问题，请先处理并关闭报告，再生成正文。");
      document.getElementById("consistency-review-list")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const { from, to } = props.editor?.state.selection ?? { from: 0, to: 0 };
    const selection = props.editor?.state.doc.textBetween(from, to, "\n").trim() ?? "";
    if ((action === "REWRITE" || action === "POLISH") && !selection) {
      setError("请先在正文编辑器中选择需要处理的文字。");
      return;
    }
    if (
      consistencyCheck
      && !props.chapterPlan.trim()
      && !props.draft.trim()
      && !props.editor?.getText().trim()
    ) {
      setError("请先填写章节执行卡或正文草稿，再运行检查。");
      return;
    }
    setBusy(true);
    const submittedInstruction = instruction;
    setError(null);
    beginRequest();
    try {
      const documentJson = reviewingManuscript && props.editor
        ? JSON.stringify(props.editor.getJSON())
        : props.draft || (props.editor ? JSON.stringify(props.editor.getJSON()) : "");
      const proposal = await generateAiProposal({
        profileId: chatProfile.id,
        chapterId: props.chapterId,
        action,
        ...(consistencyCheck ? { reviewPurpose } : {}),
        chapterTitle: props.chapterTitle,
        chapterPlan: props.chapterPlan,
        volumePlan: props.volumePlan,
        documentJson,
        ...(selection ? { selection } : {}),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(chatPreference.temperature !== null ? { temperature: chatPreference.temperature } : {}),
        ...(chatPreference.maxOutputTokens !== null ? { maxOutputTokens: chatPreference.maxOutputTokens } : {}),
        stream: true,
      });
      setInstructionBaseline(submittedInstruction);
      if (selection) {
        setProposalAnchors((value) => ({
          ...value,
          [proposal.id]: { from, to, selection },
        }));
      }
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(aiFailureMessage(cause)); }
    finally {
      finishRequest();
      setBusy(false);
    }
  }

  async function cancel() {
    if (!effectiveTaskId) return;
    try { await cancelAiTask(effectiveTaskId); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  async function refreshChapterMemory() {
    try {
      await enqueueChapterSummaryRefresh(props.chapterId);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["summary-materials"] }),
        client.invalidateQueries({ queryKey: ["jobs"] }),
      ]);
      setFallbackNotice("章节记忆已加入后台队列");
      setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const selectedChatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "writing");
  const selectedChatPreference = resolveTaskPreference(aiPreferences.data, "writing");
  const reviewProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "consistencyReview");
  const reviewPreference = resolveTaskPreference(aiPreferences.data, "consistencyReview");
  const pending = proposals.data?.filter((item) => item.proposal.status === "PENDING") ?? [];
  const pendingReviews = pending.filter((item) =>
    item.proposal.action === "CONSISTENCY_CHECK" && item.proposal.reviewPurpose === reviewPurpose);
  const actionablePending = pending.filter((item) => item.proposal.action !== "CONSISTENCY_CHECK");
  const pendingCandidates = actionablePending.filter((item) => item.validation.status !== "NEEDS_INPUT");
  const retainedEditIds = proposals.isSuccess ? [...new Set([
    ...Object.keys(textEdits.entries), ...Object.keys(feedbackEdits.entries),
  ])].filter((id) => !actionablePending.some((item) => item.proposal.id === id)
    && ((textEdits.entries[id] && textEdits.entries[id]!.value !== textEdits.entries[id]!.baseline)
      || (feedbackEdits.entries[id] && feedbackEdits.entries[id]!.value !== feedbackEdits.entries[id]!.baseline))) : [];
  const needsInputCandidates = actionablePending.filter((item) => item.validation.status === "NEEDS_INPUT");
  const latestConsistencyReview = pendingReviews[0] ?? null;
  const latestConsistencyReport = latestConsistencyReview?.consistency ?? null;
  const consistencyFreshness = latestConsistencyReview?.consistencyFreshness ?? null;
  const reviewPolicy = reviewPolicyQuery.data ?? "BALANCED";
  const admissionEnabled = auditFlow.data?.admission !== false;
  const consistencyNotice = admissionEnabled && !reviewingManuscript && (latestConsistencyReport || reviewPolicy === "REQUIRED")
    ? consistencyAdmission(latestConsistencyReport, consistencyFreshness, reviewPolicy)
    : null;
  const freshVerdictBlocked = admissionEnabled && reviewPolicy !== "ADVISORY"
    && consistencyFreshness === "FRESH"
    && latestConsistencyReport?.verdict === "BLOCKED";
  const strictReviewBlocked = admissionEnabled && reviewPolicy === "REQUIRED"
    && (!latestConsistencyReview
      || consistencyFreshness !== "FRESH"
      || latestConsistencyReport?.verdict === "UNPARSED");
  const consistencyBlocked = freshVerdictBlocked || strictReviewBlocked;
  const compareReviews = compareIds
    .map((id) => pendingCandidates.find((item) => item.proposal.id === id))
    .filter((item): item is AiProposalReview => Boolean(item));
  const readinessLoading = planningSections.isPending || entities.isPending;
  const readiness = assessWritingReadiness({
    sections: planningSections.data ?? [],
    hasCharacterCard: (entities.data ?? []).some((entity) => entity.entityType === "CHARACTER"),
    hasChapterPlan: Boolean(props.chapterPlan.trim()),
  });
  const currentDraftAvailable = Boolean(props.editor?.getText().trim()) || documentHasText(props.draft);
  const visibleDraftAvailable = currentDraftAvailable;
  const canRunConsistencyCheck = reviewingManuscript
    ? currentDraftAvailable
    : Boolean(props.chapterPlan.trim() || currentDraftAvailable);
  const writingActionBlocked = (action: AiAction) =>
    consistencyBlocked && (action === "DRAFT" || action === "CONTINUE");
  return <section className="ai-panel" aria-label={isReadinessMode ? "创作准备" : isReviewMode ? reviewingManuscript ? "正文候选审核" : "创作准入" : "AI 创作"}>
    {isReadinessMode ? <>
      <div className="section-heading ai-stage-heading"><div><h2><ClipboardCheck size={15} />创作准备</h2><p>集中检查正式设定、人物卡和章节执行卡，缺少的内容可在这里补齐。</p></div><span>生成正文前</span></div>
      <WritingReadinessPanel active={active} chapterId={props.chapterId} chapterTitle={props.chapterTitle} volumeId={props.volumeId} volumePlan={props.volumePlan} readiness={readiness} loading={readinessLoading} sections={planningSections.data ?? []} onOpenChapterPlan={props.onOpenChapterPlan} />
    </> : null}

    {isCreationMode ? <>
      <div className="section-heading ai-stage-heading"><div><h2><Sparkles size={15} />AI 创作</h2><p>填写本章补充意见，生成正文，并在候选写入草稿前完成确认。</p></div><div className="proposal-heading-actions"><span>{chapterSummary || chapterSummaryJob ? chapterSummaryStatus : "尚未生成章节记忆"}</span><button type="button" className="secondary-action" onClick={() => void refreshChapterMemory()} disabled={!visibleDraftAvailable || Boolean(chapterSummaryJob)}><RefreshCw size={14} />更新章节记忆</button>{lastApplied ? <button type="button" onClick={undoLastApplied}><RotateCcw size={12} />撤销“{lastApplied.label}”</button> : null}</div></div>
      <AiModelNote active={active} taskLabel="正文书写" taskKey="writing" profile={selectedChatProfile} preference={selectedChatPreference} />
      {consistencyNotice ? <div className="consistency-admission creation-admission" data-state={consistencyNotice.state}><span>{consistencyNotice.text}</span>{consistencyBlocked && props.onOpenAdmissionReview ? <button type="button" className="secondary-action" onClick={props.onOpenAdmissionReview}>前往创作准入处理</button> : null}</div> : null}
      <label className="ai-instruction">本章补充意见<textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：让冲突逐步升级，保留主角的克制感；控制在 3000 字左右，结尾留下身份线索" /></label>
      <p className="ai-request-hint">系统会把这段意见与章节执行卡、写作规则和正文上下文一起编译成模型消息。</p>
      <div className="ai-creation-options">
        <div className="ai-draft-action"><div><strong>{visibleDraftAvailable ? "重新生成整章草稿" : "按章节执行卡生成整章"}</strong><span>{visibleDraftAvailable ? "适合整体推翻当前草稿。采用候选时会明确提示整章替换。" : "根据章节目标、关键冲突、结尾钩子和项目上下文生成完整初稿。"}</span></div><button type="button" className="primary-action" onClick={() => void runAction("DRAFT")} disabled={generationLocked || !selectedChatProfile?.hasSecret || writingActionBlocked("DRAFT")} title={consistencyBlocked ? "先处理创作准入中的阻断问题并关闭报告" : undefined}><Sparkles size={14} />{visibleDraftAvailable ? "生成新版整章" : "生成整章草稿"}</button></div>
      </div>
    </> : null}

    {isReviewMode ? <>
      <div className="section-heading ai-stage-heading"><div><h2><ShieldCheck size={15} />{reviewingManuscript ? "正文候选审核" : "创作准入"}</h2><p>{reviewingManuscript ? "检查候选区当前未同步的内容是否与人物状态、世界规则、时间线、既定事实和执行卡一致。" : "生成正文前，检查章节执行卡、正式设定和已有草稿是否足以支撑本次创作。"}</p></div><span>{reviewingManuscript ? "同步前检查" : "生成前检查"}</span></div>
      <section className="ai-consistency-action" aria-label={reviewingManuscript ? "发起正文候选审核" : "发起创作准入检查"}>
      <AiModelNote active={active} taskLabel={reviewingManuscript ? "正文候选审核" : "创作准入"} taskKey="consistencyReview" profile={reviewProfile} preference={reviewPreference} />
      <div className="ai-consistency-action-bar">
        <div><strong>{reviewingManuscript ? "审核当前候选" : "检查本次创作条件"}</strong><span>{reviewingManuscript ? "以候选区当前内容为主体，对照章节执行卡和正式知识；候选修改后，旧报告会自动过期。" : "对照分卷规划和正式知识检查执行卡；已有正文时也会纳入，结果用于生成准入。"}</span></div>
        <button type="button" className="secondary-action" onClick={() => void runAction("CONSISTENCY_CHECK")} disabled={generationLocked || !reviewProfile?.hasSecret || !canRunConsistencyCheck}><ShieldCheck size={14} />{reviewingManuscript ? "审核当前候选" : "检查创作条件"}</button>
      </div>
      {error ? <p className="project-error ai-review-error" role="alert" aria-live="assertive">{error}</p> : null}
      {reviewingManuscript && !currentDraftAvailable ? <p className="consistency-admission" data-state="needs_input">请先填写候选内容，再运行候选审核。</p> : null}
      {consistencyNotice ? <p className="consistency-admission" data-state={consistencyNotice.state}>{consistencyNotice.text}</p> : null}
      </section>
    </> : null}
    {(isCreationMode || isReviewMode) && generationBusy ? <div className="ai-running"><LoaderCircle size={15} className="spin" /><span>模型正在生成结果…</span><button type="button" className="secondary-action" onClick={() => void cancel()} disabled={!effectiveTaskId}><Ban size={14} />取消</button></div> : null}
    {!isReadinessMode && fallbackNotice ? <p className="project-notice" role="status">{fallbackNotice}</p> : null}
    {!isReadinessMode && preview ? <pre className="ai-preview">{preview}</pre> : null}
    {!isReadinessMode && !isReviewMode && error ? <p className="project-error" role="alert">{error}</p> : null}
    {isCreationMode && unappliedCandidate ? <article className="proposal">
      <strong>暂未写入的候选</strong>
      <textarea readOnly value={unappliedCandidate.text} aria-label="暂未写入的候选文本" />
      <div className="ai-actions">
        <button type="button" className="primary-action" disabled={!props.editor} onClick={() => {
          const { proposal, text } = unappliedCandidate;
          const range = resolveReplacementRange(proposal);
          if ((proposal.action === "REWRITE" || proposal.action === "POLISH") && !range) {
            setError("原选区已经变化，请保留候选文本并手动核对替换位置。");
            return;
          }
          if (!window.confirm("将此候选应用到当前正文草稿吗？整章候选会替换当前内容。")) return;
          if (applyText(proposal, text, range ?? undefined)) { setUnappliedCandidate(null); setError(null); }
        }}><Check size={13} />重新应用到草稿</button>
        <button type="button" className="secondary-action" onClick={() => {
          if (window.confirm("关闭这条暂未写入的候选吗？")) setUnappliedCandidate(null);
        }}><X size={13} />关闭保留候选</button>
      </div>
    </article> : null}

    {isCreationMode ? <div className="proposal-list" aria-label="候选确认">
      <div className="section-heading"><h3><ShieldCheck size={14} />候选确认</h3><span>{proposals.isPending ? "正在加载" : `${pendingCandidates.length} 条待确认${needsInputCandidates.length ? ` · ${needsInputCandidates.length} 条需补资料` : ""}${pendingCandidates.length >= 2 ? ` · 已选 ${compareIds.length}/2 对比` : ""}`}</span></div>
      {proposals.isPending ? <div className="proposal-empty"><LoaderCircle size={18} className="spin" /><div><strong>正在读取待审核候选</strong><span>生成结果会保留在这里，确认前不会写入正文。</span></div></div> : proposals.isError ? <p className="project-error" role="alert">候选审核加载失败：{errorMessage(proposals.error)}</p> : actionablePending.length ? <>
      {actionablePending.map(({ proposal, validation, feedback }) => {
        const needsInput = validation.status === "NEEDS_INPUT";
        const text = partialTexts[proposal.id] ?? proposal.outputText;
        const needsInputTargets = needsInput ? findWritingGapTargets(text) : [];
        const original = proposalAnchors[proposal.id]?.selection
          ?? ((proposal.action === "REWRITE" || proposal.action === "POLISH") && props.editor && !props.editor.state.selection.empty
            ? props.editor.state.doc.textBetween(props.editor.state.selection.from, props.editor.state.selection.to, "\n").trim()
            : "");
        const diffRows = original ? buildLineDiff(original, text) : [];
        return <article className="proposal" data-state={needsInput ? "needs-input" : undefined} id={`ai-proposal-${proposal.id}`} key={proposal.id}>
        <div className="proposal-meta"><strong>{actionLabels[proposal.action]}</strong><span className="proposal-validation" data-status={validation.status.toLowerCase()}>{needsInput ? "需补资料" : validation.status === "VALID" ? "校验通过" : validation.status === "WARNING" ? "需要检查" : "无效输出"} · {validation.characterCount} 字</span>{!needsInput && pendingCandidates.length >= 2 ? <button type="button" data-active={compareIds.includes(proposal.id) || undefined} onClick={() => toggleCompare(proposal.id)}><Columns2 size={12} />加入对比</button> : null}</div>
        {validation.messages.length ? <div className="proposal-validation-messages">{validation.messages.map((message) => <span key={message}>{message}</span>)}</div> : null}
        {needsInput ? <div className="proposal-needs-input"><strong>模型没有生成正文</strong><span>它要求先补齐可能影响本章人物、能力、世界规则或失败后果的正式设定。</span><pre>{text}</pre></div> : null}
        {!needsInput && original ? <details className="proposal-diff" open><summary>原文与候选差异<span>{proposalAnchors[proposal.id] ? "已绑定生成时选区" : "使用当前选区"}</span></summary><div>{diffRows.map((row, index) => <p data-kind={row.kind} key={`${row.kind}-${index}`}><span>{row.kind === "removed" ? "-" : row.kind === "added" ? "+" : " "}</span>{row.text || " "}</p>)}</div></details> : null}
        {!needsInput ? <textarea value={text} disabled={decidingProposalId === proposal.id} onChange={(event) => textEdits.edit(proposal.id, event.target.value, proposal.outputText)} aria-label={`${actionLabels[proposal.action]}候选文本`} /> : null}
        {textEdits.entries[proposal.id] && text !== proposal.outputText ? <button type="button" className="secondary-action" disabled={decidingProposalId !== null} onClick={() => {
          if (window.confirm("放弃这条候选的文本修改吗？")) textEdits.discard(proposal.id);
        }}><RotateCcw size={13} />还原候选文本</button> : null}
        {!needsInput ? <details className="proposal-feedback-details"><summary>评价本次结果（可选）</summary><div className="proposal-feedback">
          <input value={feedbackNotes[proposal.id] ?? feedback?.note ?? ""} disabled={decidingProposalId === proposal.id} onChange={(event) => feedbackEdits.edit(proposal.id, event.target.value, feedback?.note ?? "")} placeholder="记录这条候选的优点或问题" maxLength={2000} aria-label="候选质量反馈" />
          <button type="button" disabled={feedbackBusyId !== null || decidingProposalId !== null} data-active={feedback?.rating === "HELPFUL" || undefined} onClick={() => void submitFeedback(proposal, "HELPFUL")} title="标记为有帮助"><ThumbsUp size={13} />有帮助</button>
          <button type="button" disabled={feedbackBusyId !== null || decidingProposalId !== null} data-active={feedback?.rating === "NOT_HELPFUL" || undefined} onClick={() => void submitFeedback(proposal, "NOT_HELPFUL")} title="标记为需改进"><ThumbsDown size={13} />需改进</button>
        </div></details> : null}
        <div className="ai-actions">{needsInput ? <>{needsInputTargets.length ? needsInputTargets.map((target) => <a className="primary-action" href={target.id === "chapter-plan" ? `/chapters#${props.chapterId}` : target.href} key={target.id}>{target.label}</a>) : <a className="primary-action" href="/planning">打开作品规划</a>}<button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />关闭</button></> : <><button type="button" className="primary-action" onClick={() => void decide(proposal, "ACCEPTED")} disabled={decidingProposalId !== null} title={proposal.action === "DRAFT" && visibleDraftAvailable ? "采用后将替换当前正文草稿" : undefined}><Check size={14} />{decidingProposalId === proposal.id ? "处理中…" : proposal.action === "SUMMARIZE" ? "保留摘要" : proposal.action === "DRAFT" ? "采用到正文草稿" : proposal.action === "CONTINUE" ? "追加到正文草稿" : "应用到正文草稿"}</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />放弃候选</button></>}</div>
      </article>;
      })}
      {compareReviews.length === 2 ? <section className="proposal-compare">
        <div className="section-heading"><h3>候选对比</h3><span>A：左 · B：右</span></div>
        <div className="proposal-compare-grid">
          {compareReviews.map(({ proposal, validation }, index) => <div key={proposal.id}>
            <strong>{index === 0 ? "候选 A" : "候选 B"} · {actionLabels[proposal.action]}</strong>
            <small>{validation.characterCount} 字 · 约 {validation.estimatedOutputTokens} tokens · {validation.paragraphCount} 段</small>
            <pre>{partialTexts[proposal.id] ?? proposal.outputText}</pre>
          </div>)}
        </div>
      </section> : null}
      </> : <div className="proposal-empty review-empty"><ShieldCheck size={20} /><div><strong>当前没有正文候选待确认</strong><span>{pendingReviews.length ? "检查报告已移到“创作准入”页签，这里只保留可以写入正文的候选。" : "生成结果会先停在这里，你确认后才会写入正文。"}</span></div></div>}
      {retainedEditIds.map((id) => <article className="proposal" key={`retained-${id}`}>
        <p role="status">候选已不在待确认列表，本地修改仍保留。</p>
        {textEdits.entries[id] ? <textarea readOnly value={textEdits.entries[id]!.value} aria-label="保留的候选文本修改" /> : null}
        {feedbackEdits.entries[id] ? <input readOnly value={feedbackEdits.entries[id]!.value} aria-label="保留的候选评价修改" /> : null}
        <button type="button" className="secondary-action" onClick={() => {
          if (!window.confirm("放弃这条候选保留的本地修改吗？")) return;
          textEdits.discard(id);
          feedbackEdits.discard(id);
        }}><Trash2 size={13} />放弃保留修改</button>
      </article>)}
    </div> : null}
    {isReviewMode ? <AiConsistencyReviewList
      reviews={pendingReviews} active={active} reviewingManuscript={reviewingManuscript}
      partialTexts={partialTexts} reviewPolicy={reviewPolicy} generationLocked={generationLocked}
      hasReviewSecret={Boolean(reviewProfile?.hasSecret)} canRunConsistencyCheck={canRunConsistencyCheck}
      decidingProposalId={decidingProposalId} chapterId={props.chapterId}
      onReturnToEditor={props.onReturnToEditor} onOpenChapterPlan={props.onOpenChapterPlan}
      onRunReview={() => void runAction("CONSISTENCY_CHECK")} onCloseReview={(proposal) => void decide(proposal, "REJECTED")}
    /> : null}
  </section>;
}
