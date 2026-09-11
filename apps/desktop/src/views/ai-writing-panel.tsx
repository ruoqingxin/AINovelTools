import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/react";
import { Ban, Check, Columns2, LoaderCircle, Play, RotateCcw, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import {
  cancelAiTask,
  decideAiProposal,
  errorMessage,
  generateAiProposal,
  getWritingReviewPolicy,
  listAiProposals,
  listEntities,
  listModelProfiles,
  listPlanningSections,
  rateAiProposal,
  type AiAction,
  type AiConsistencyReport,
  type AiConsistencySeverity,
  type AiConsistencyVerdict,
  type AiProposal,
  type AiProposalReview,
  type ConsistencyReviewFreshness,
  type WritingReviewPolicy,
} from "../lib/tauri-client";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { assessWritingReadiness, findWritingGapTargets } from "../lib/writing-readiness";
import { AiModelNote } from "./ai-model-note";
import { WritingReadinessPanel } from "./writing-readiness-panel";

const actionLabels: Record<AiAction, string> = {
  DRAFT: "AI 创作整章",
  CONTINUE: "续写",
  REWRITE: "重写选区",
  POLISH: "润色选区",
  SUMMARIZE: "章节摘要",
  CONSISTENCY_CHECK: "一致性审核",
};
const editingActions: AiAction[] = ["CONTINUE", "REWRITE", "POLISH", "SUMMARIZE"];
const consistencyVerdictLabels: Record<AiConsistencyVerdict, string> = {
  PASS: "审核通过",
  REVIEW: "需要复核",
  BLOCKED: "审核阻断",
  NEEDS_INPUT: "需补资料",
  UNPARSED: "报告格式异常",
};
const consistencySeverityLabels: Record<AiConsistencySeverity, string> = {
  BLOCKER: "阻断",
  MAJOR: "严重",
  MINOR: "一般",
  INFO: "提示",
};

function consistencyAdmission(
  report: AiConsistencyReport | null,
  freshness: ConsistencyReviewFreshness | null,
  policy: WritingReviewPolicy,
) {
  if (!report) {
    return {
      state: "blocked",
      text: "当前作品采用严格准入，生成正文前必须完成一次与当前内容一致的一致性审核。",
    };
  }
  const blockerCount = report.findings.filter((finding) => finding.severity === "BLOCKER").length;
  if (policy === "ADVISORY" && (report.verdict === "BLOCKED" || report.verdict === "NEEDS_INPUT")) {
    return {
      state: "advisory",
      text: report.verdict === "BLOCKED"
        ? `当前为建议模式，审核发现 ${blockerCount} 个阻断问题，但不会阻止生成正文。`
        : "当前为建议模式，审核提示资料不足，但不会阻止生成正文。",
    };
  }
  if (freshness === "STALE") {
    return policy === "REQUIRED"
      ? {
          state: "stale",
          text: "审核依据已经变化，严格准入已暂停生成。请按当前执行卡、正文和正式设定重新审核。",
        }
      : {
          state: "stale",
          text: "审核依据已经变化，这份报告已过期，不再阻止正文生成。请按当前执行卡、正文和正式设定重新审核。",
        };
  }
  if (freshness === "UNVERIFIED") {
    return policy === "REQUIRED"
      ? {
          state: "unverified",
          text: "无法确认现有审核是否对应当前正文与设定，严格准入已暂停生成。请重新审核。",
        }
      : {
          state: "unverified",
          text: "暂时无法确认审核与当前内容是否一致，这份报告仅作提示，不再阻止生成。",
        };
  }
  if (policy === "REQUIRED" && report.verdict === "UNPARSED") {
    return {
      state: "unparsed",
      text: "审核报告格式无法解析，严格准入已暂停生成。请重新审核并确认报告格式。",
    };
  }
  if (report.verdict === "BLOCKED") {
    return {
      state: "blocked",
      text: `最近一次审核发现 ${blockerCount} 个阻断问题，整章创作与续写已暂停。请先处理问题并关闭本次审核。`,
    };
  }
  if (report.verdict === "NEEDS_INPUT") {
    return {
      state: "needs_input",
      text: "审核缺少判断准入所需的正式设定。补齐资料并关闭本次审核后，才能继续生成正文。",
    };
  }
  if (report.verdict === "REVIEW") {
    return {
      state: "review",
      text: `审核有 ${report.findings.length} 条问题需要复核，不阻止生成，但建议先确认依据。`,
    };
  }
  if (report.verdict === "PASS") {
    return { state: "pass", text: "审核通过，未发现阻断正文生成的冲突。" };
  }
  return {
    state: "unparsed",
    text: "审核报告格式无法识别，请查看原始报告后再决定是否生成。",
  };
}

function textContent(text: string) {
  return text.split(/\r?\n/).map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : undefined,
  }));
}

function candidateSegments(text: string) {
  return text.split(/\n{2,}/).map((segment) => segment.trim()).filter(Boolean);
}

function buildLineDiff(left: string, right: string) {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const rows: Array<{ kind: "same" | "removed" | "added"; text: string }> = [];
  const table = Array.from({ length: leftLines.length + 1 }, () => Array<number>(rightLines.length + 1).fill(0));

  for (let leftIndex = leftLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightLines.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex]![rightIndex] = leftLines[leftIndex] === rightLines[rightIndex]
        ? table[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(table[leftIndex + 1]![rightIndex]!, table[leftIndex]![rightIndex + 1]!);
    }
  }

  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
    if (leftIndex < leftLines.length && rightIndex < rightLines.length && leftLines[leftIndex] === rightLines[rightIndex]) {
      rows.push({ kind: "same", text: leftLines[leftIndex]! });
      leftIndex += 1;
      rightIndex += 1;
    } else if (rightIndex < rightLines.length && (leftIndex === leftLines.length || table[leftIndex]![rightIndex + 1]! >= table[leftIndex + 1]![rightIndex]!)) {
      rows.push({ kind: "added", text: rightLines[rightIndex]! });
      rightIndex += 1;
    } else {
      rows.push({ kind: "removed", text: leftLines[leftIndex] ?? "" });
      leftIndex += 1;
    }
  }
  return rows;
}

type ProposalAnchor = {
  from: number;
  to: number;
  selection: string;
};

export function AiWritingPanel(props: { chapterId: string; chapterTitle: string; chapterPlan: string; volumeId: string; volumePlan: string; draft: string; editor: Editor | null }) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const reviewPolicyQuery = useQuery({ queryKey: ["writing-review-policy"], queryFn: getWritingReviewPolicy });
  const planningSections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const entities = useQuery({ queryKey: ["entities", false], queryFn: () => listEntities(false) });
  const [instruction, setInstruction] = useState("");
  const deferredInstruction = useDeferredValue(instruction);
  const currentDocumentJson = props.draft || (props.editor ? JSON.stringify(props.editor.getJSON()) : "");
  const deferredDocumentJson = useDeferredValue(currentDocumentJson);
  const proposals = useQuery({
    queryKey: ["ai-proposals", props.chapterId, props.chapterPlan, deferredDocumentJson, deferredInstruction],
    queryFn: () => listAiProposals({
      chapterId: props.chapterId,
      chapterTitle: props.chapterTitle,
      chapterPlan: props.chapterPlan,
      documentJson: deferredDocumentJson,
      ...(deferredInstruction.trim() ? { instruction: deferredInstruction.trim() } : {}),
    }),
  });
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [partialTexts, setPartialTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [decidingProposalId, setDecidingProposalId] = useState<string | null>(null);
  const [feedbackNotes, setFeedbackNotes] = useState<Record<string, string>>({});
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [proposalAnchors, setProposalAnchors] = useState<Record<string, ProposalAnchor>>({});
  const [segmentSelections, setSegmentSelections] = useState<Record<string, number[]>>({});
  const [lastApplied, setLastApplied] = useState<{ documentJson: string; label: string } | null>(null);

  useEffect(() => {
    let disposed = false;
    const subscriptions = Promise.all([
      listen<{ taskId: string }>("ai-task-started", ({ payload }) => {
        if (!disposed) { setActiveTaskId(payload.taskId); setPreview(""); }
      }),
      listen<{ taskId: string; chunk: string }>("ai-task-chunk", ({ payload }) => {
        if (!disposed) { setActiveTaskId(payload.taskId); setPreview((value) => value + payload.chunk); }
      }),
      listen<{ taskId: string; attempt: number; profileName: string; fallbackReason?: string }>("ai-task-attempt", ({ payload }) => {
        if (!disposed && payload.attempt > 1) {
          setActiveTaskId(payload.taskId);
          setPreview("");
          setFallbackNotice(`主模型调用失败（${payload.fallbackReason ?? "未知原因"}），已切换到“${payload.profileName}”继续生成。`);
        }
      }),
    ]);
    return () => { disposed = true; void subscriptions.then((items) => items.forEach((unlisten) => unlisten())); };
  }, []);

  useEffect(() => {
    setPreview("");
    setError(null);
    setFallbackNotice(null);
    setCompareIds([]);
    setProposalAnchors({});
    setSegmentSelections({});
    setLastApplied(null);
  }, [props.chapterId]);

  async function runAction(action: AiAction) {
    const consistencyCheck = action === "CONSISTENCY_CHECK";
    const taskKey = consistencyCheck ? "consistencyReview" : "writing";
    const chatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, taskKey);
    const chatPreference = resolveTaskPreference(aiPreferences.data, taskKey);
    if (!chatProfile || (!props.editor && !consistencyCheck)) return;
    if ((action === "DRAFT" || action === "CONTINUE") && !readinessLoading && !readiness.canGenerate) {
      setError("请先补齐创作准入中列出的关键设定，再生成正文。");
      document.getElementById("writing-readiness")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if ((action === "DRAFT" || action === "CONTINUE") && consistencyBlocked) {
      setError("最近一次一致性审核存在阻断问题，请先处理并关闭审核，再生成或续写正文。");
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
      setError("请先填写章节执行卡或正文草稿，再运行一致性审核。");
      return;
    }
    setBusy(true);
    setError(null);
    setFallbackNotice(null);
    setPreview("");
    try {
      const documentJson = props.draft || (props.editor ? JSON.stringify(props.editor.getJSON()) : "");
      const proposal = await generateAiProposal({
        profileId: chatProfile.id,
        chapterId: props.chapterId,
        action,
        chapterTitle: props.chapterTitle,
        chapterPlan: props.chapterPlan,
        documentJson,
        ...(selection ? { selection } : {}),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(chatPreference.temperature !== null ? { temperature: chatPreference.temperature } : {}),
        ...(chatPreference.maxOutputTokens !== null ? { maxOutputTokens: chatPreference.maxOutputTokens } : {}),
        stream: true,
      });
      setPartialTexts((value) => ({ ...value, [proposal.id]: proposal.outputText }));
      if (selection) {
        setProposalAnchors((value) => ({
          ...value,
          [proposal.id]: { from, to, selection },
        }));
      }
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally {
      void client.invalidateQueries({ queryKey: ["ai-runs"] });
      setBusy(false);
      setActiveTaskId(null);
    }
  }

  async function cancel() {
    if (!activeTaskId) return;
    try { await cancelAiTask(activeTaskId); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  function resolveReplacementRange(proposal: AiProposal) {
    if (!props.editor || (proposal.action !== "REWRITE" && proposal.action !== "POLISH")) return null;
    const anchor = proposalAnchors[proposal.id];
    if (anchor) {
      const currentSelection = props.editor.state.doc.textBetween(anchor.from, anchor.to, "\n").trim();
      return currentSelection === anchor.selection
        ? { from: anchor.from, to: anchor.to, source: "stored" as const }
        : null;
    }
    const { from, to, empty } = props.editor.state.selection;
    if (empty) return null;
    return { from, to, source: "current" as const };
  }

  function applyText(proposal: AiProposal, text: string, range?: { from: number; to: number }) {
    if (!props.editor || proposal.action === "SUMMARIZE") return false;
    const previousDocument = JSON.stringify(props.editor.getJSON());
    if (proposal.action === "DRAFT") {
      props.editor.commands.setContent({ type: "doc", content: textContent(text) });
    } else if (proposal.action === "CONTINUE") {
      props.editor.commands.insertContentAt(props.editor.state.doc.content.size, textContent(text));
    } else if (range) {
      props.editor.commands.insertContentAt(range, textContent(text));
    } else {
      return false;
    }
    setLastApplied({ documentJson: previousDocument, label: actionLabels[proposal.action] });
    return true;
  }

  function selectedCandidateText(proposal: AiProposal) {
    const text = partialTexts[proposal.id] ?? proposal.outputText;
    const segments = candidateSegments(text);
    const selected = segmentSelections[proposal.id] ?? segments.map((_, index) => index);
    return segments.filter((_, index) => selected.includes(index)).join("\n\n");
  }

  function undoLastApplied() {
    if (!props.editor || !lastApplied) return;
    try {
      props.editor.commands.setContent(JSON.parse(lastApplied.documentJson), { emitUpdate: true });
      setLastApplied(null);
      setError(null);
    } catch {
      setError("无法撤销上一次应用，请使用正文历史版本恢复。");
    }
  }

  async function decide(proposal: AiProposal, mode: "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED", acceptedTextOverride?: string) {
    setError(null);
    const proposalValidation = proposals.data?.find((item) => item.proposal.id === proposal.id)?.validation;
    if (mode !== "REJECTED" && proposalValidation?.status === "NEEDS_INPUT") {
      setError("这次结果没有生成正文，需要先补齐模型列出的关键设定。");
      return;
    }
    if (mode !== "REJECTED" && proposal.action === "DRAFT" && props.editor?.getText().trim() && !window.confirm("应用整章创作候选会替换当前正文草稿。确定继续吗？")) return;
    const replacementRange = mode !== "REJECTED" ? resolveReplacementRange(proposal) : null;
    if (mode !== "REJECTED" && proposal.action !== "SUMMARIZE") {
      if (!props.editor) {
        setError("正文编辑器尚未准备好。");
        return;
      }
      if ((proposal.action === "REWRITE" || proposal.action === "POLISH") && !replacementRange) {
        setError("生成候选后原文已经变化，系统为避免替换错位置已停止应用。请撤销正文改动，或重新生成候选。");
        return;
      }
    }
    setDecidingProposalId(proposal.id);
    try {
      const acceptedText = mode === "PARTIALLY_ACCEPTED"
        ? acceptedTextOverride ?? selectedCandidateText(proposal)
        : undefined;
      const decided = await decideAiProposal({ id: proposal.id, status: mode, ...(acceptedText ? { acceptedText } : {}) });
      if (mode !== "REJECTED") applyText(proposal, decided.acceptedText ?? proposal.outputText, replacementRange ?? undefined);
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setDecidingProposalId(null); }
  }

  async function submitFeedback(proposal: AiProposal, rating: "HELPFUL" | "NOT_HELPFUL") {
    setError(null);
    try {
      await rateAiProposal(proposal.id, rating, feedbackNotes[proposal.id]?.trim() || undefined);
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function toggleCompare(proposalId: string) {
    setCompareIds((current) => current.includes(proposalId)
      ? current.filter((id) => id !== proposalId)
      : current.length >= 2 ? [current[1]!, proposalId] : [...current, proposalId]);
  }

  const selectedChatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "writing");
  const selectedChatPreference = resolveTaskPreference(aiPreferences.data, "writing");
  const reviewProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "consistencyReview");
  const reviewPreference = resolveTaskPreference(aiPreferences.data, "consistencyReview");
  const pending = proposals.data?.filter((item) => item.proposal.status === "PENDING") ?? [];
  const pendingReviews = pending.filter((item) => item.proposal.action === "CONSISTENCY_CHECK");
  const actionablePending = pending.filter((item) => item.proposal.action !== "CONSISTENCY_CHECK");
  const pendingCandidates = actionablePending.filter((item) => item.validation.status !== "NEEDS_INPUT");
  const needsInputCandidates = actionablePending.filter((item) => item.validation.status === "NEEDS_INPUT");
  const latestConsistencyReview = pendingReviews[0] ?? null;
  const latestConsistencyReport = latestConsistencyReview?.consistency ?? null;
  const consistencyFreshness = latestConsistencyReview?.consistencyFreshness ?? null;
  const reviewPolicy = reviewPolicyQuery.data ?? "BALANCED";
  const consistencyNotice = latestConsistencyReport || reviewPolicy === "REQUIRED"
    ? consistencyAdmission(latestConsistencyReport, consistencyFreshness, reviewPolicy)
    : null;
  const freshVerdictBlocked = reviewPolicy !== "ADVISORY"
    && consistencyFreshness === "FRESH"
    && (latestConsistencyReport?.verdict === "BLOCKED"
      || latestConsistencyReport?.verdict === "NEEDS_INPUT");
  const strictReviewBlocked = reviewPolicy === "REQUIRED"
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
  const admissionBlocked = !readinessLoading && !readiness.canGenerate;
  const canRunConsistencyCheck = Boolean(
    props.chapterPlan.trim() || props.draft.trim() || props.editor?.getText().trim(),
  );
  const writingActionBlocked = (action: AiAction) =>
    (admissionBlocked || consistencyBlocked) && (action === "DRAFT" || action === "CONTINUE");

  return <section className="ai-panel" aria-label="AI 创作">
    <div className="section-heading"><h2><Sparkles size={15} />AI 创作</h2><div className="proposal-heading-actions"><span>云端 API · Proposal 审核</span>{lastApplied ? <button type="button" onClick={undoLastApplied}><RotateCcw size={12} />撤销“{lastApplied.label}”</button> : null}</div></div>
    <AiModelNote taskLabel="正文书写" taskKey="writing" profile={selectedChatProfile} preference={selectedChatPreference} />
    <WritingReadinessPanel chapterId={props.chapterId} chapterTitle={props.chapterTitle} volumeId={props.volumeId} volumePlan={props.volumePlan} readiness={readiness} loading={readinessLoading} sections={planningSections.data ?? []} />
    <label className="ai-instruction">本章补充意见<textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：让冲突逐步升级，保留主角的克制感；控制在 3000 字左右，结尾留下身份线索" /></label>
    <p className="ai-request-hint">系统会把这段意见与章节执行卡、写作规则和正文上下文一起编译成模型消息。</p>
    <div className="ai-draft-action"><div><strong>按章节执行卡创作整章</strong><span>AI 会参考章节目标、关键冲突、结尾钩子和项目上下文生成完整初稿，确认后替换到正文。</span></div><button type="button" className="primary-action" onClick={() => void runAction("DRAFT")} disabled={busy || !selectedChatProfile?.hasSecret || writingActionBlocked("DRAFT")} title={consistencyBlocked ? "先处理一致性审核中的阻断问题并关闭审核" : undefined}><Sparkles size={14} />生成整章初稿</button></div>
    <div className="ai-action-grid">{editingActions.map((action) => <button type="button" className="secondary-action" key={action} onClick={() => void runAction(action)} disabled={busy || !selectedChatProfile?.hasSecret || writingActionBlocked(action)}><Play size={14} />{actionLabels[action]}</button>)}</div>
    <section className="ai-consistency-action" aria-label="一致性审核">
      <div className="section-heading"><h3><ShieldCheck size={14} />一致性审核</h3><span>只检查冲突和准入，不改写正文</span></div>
      <AiModelNote taskLabel="一致性审核" taskKey="consistencyReview" profile={reviewProfile} preference={reviewPreference} />
      <div className="ai-consistency-action-bar">
        <div><strong>审核执行卡与当前草稿</strong><span>核对人物身份、能力边界、世界规则、时间线、既定事实和叙述人称，问题会保留在独立审核区。</span></div>
        <button type="button" className="secondary-action" onClick={() => void runAction("CONSISTENCY_CHECK")} disabled={busy || !reviewProfile?.hasSecret || !canRunConsistencyCheck}><ShieldCheck size={14} />开始审核</button>
      </div>
      {consistencyNotice ? <p className="consistency-admission" data-state={consistencyNotice.state}>{consistencyNotice.text}</p> : null}
    </section>
    {busy ? <div className="ai-running"><LoaderCircle size={15} className="spin" /><span>模型正在生成结果…</span><button type="button" className="secondary-action" onClick={() => void cancel()} disabled={!activeTaskId}><Ban size={14} />取消</button></div> : null}
    {fallbackNotice ? <p className="project-notice" role="status">{fallbackNotice}</p> : null}
    {preview ? <pre className="ai-preview">{preview}</pre> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}

    <div className="proposal-list" aria-label="候选审核">
      <div className="section-heading"><h3><ShieldCheck size={14} />候选审核</h3><span>{proposals.isPending ? "正在加载" : `${pendingCandidates.length} 条待审${needsInputCandidates.length ? ` · ${needsInputCandidates.length} 条需补资料` : ""} · 已选 ${compareIds.length}/2 对比`}</span></div>
      {proposals.isPending ? <div className="proposal-empty"><LoaderCircle size={18} className="spin" /><div><strong>正在读取待审核候选</strong><span>生成结果会保留在这里，确认前不会写入正文。</span></div></div> : proposals.isError ? <p className="project-error" role="alert">候选审核加载失败：{errorMessage(proposals.error)}</p> : actionablePending.length ? <>
      {actionablePending.map(({ proposal, validation, feedback }) => {
        const needsInput = validation.status === "NEEDS_INPUT";
        const text = partialTexts[proposal.id] ?? proposal.outputText;
        const needsInputTargets = needsInput ? findWritingGapTargets(text) : [];
        const segments = candidateSegments(text);
        const selectedSegments = segmentSelections[proposal.id] ?? segments.map((_, index) => index);
        const original = proposalAnchors[proposal.id]?.selection
          ?? ((proposal.action === "REWRITE" || proposal.action === "POLISH") && props.editor && !props.editor.state.selection.empty
            ? props.editor.state.doc.textBetween(props.editor.state.selection.from, props.editor.state.selection.to, "\n").trim()
            : "");
        const diffRows = original ? buildLineDiff(original, text) : [];
        return <article className="proposal" data-state={needsInput ? "needs-input" : undefined} id={`ai-proposal-${proposal.id}`} key={proposal.id}>
        <div className="proposal-meta"><strong>{actionLabels[proposal.action]}</strong><span className="proposal-validation" data-status={validation.status.toLowerCase()}>{needsInput ? "需补资料" : validation.status === "VALID" ? "校验通过" : validation.status === "WARNING" ? "需要检查" : "无效输出"} · {validation.characterCount} 字</span><code>{proposal.promptVersion}</code>{!needsInput ? <button type="button" data-active={compareIds.includes(proposal.id) || undefined} onClick={() => toggleCompare(proposal.id)}><Columns2 size={12} />对比</button> : null}</div>
        {validation.messages.length ? <div className="proposal-validation-messages">{validation.messages.map((message) => <span key={message}>{message}</span>)}</div> : null}
        {needsInput ? <div className="proposal-needs-input"><strong>模型没有生成正文</strong><span>它要求先补齐可能影响本章人物、能力、世界规则或失败后果的正式设定。</span><pre>{text}</pre></div> : null}
        {!needsInput && original ? <details className="proposal-diff" open><summary>原文与候选差异<span>{proposalAnchors[proposal.id] ? "已绑定生成时选区" : "使用当前选区"}</span></summary><div>{diffRows.map((row, index) => <p data-kind={row.kind} key={`${row.kind}-${index}`}><span>{row.kind === "removed" ? "-" : row.kind === "added" ? "+" : " "}</span>{row.text || " "}</p>)}</div></details> : null}
        {!needsInput ? <textarea value={text} onChange={(event) => {
          setPartialTexts((value) => ({ ...value, [proposal.id]: event.target.value }));
          setSegmentSelections((value) => {
            const next = { ...value };
            delete next[proposal.id];
            return next;
          });
        }} aria-label={`${actionLabels[proposal.action]}候选文本`} /> : null}
        {!needsInput && segments.length > 1 && proposal.action !== "SUMMARIZE" ? <details className="proposal-segments"><summary>按段选择<span>已选 {selectedSegments.length}/{segments.length} 段</span></summary><div>{segments.map((segment, index) => <label key={`${index}-${segment.slice(0, 16)}`}><input type="checkbox" checked={selectedSegments.includes(index)} onChange={() => setSegmentSelections((value) => {
          const current = value[proposal.id] ?? segments.map((_, segmentIndex) => segmentIndex);
          return { ...value, [proposal.id]: current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((left, right) => left - right) };
        })} /><span>{segment}</span></label>)}</div></details> : null}
        {!needsInput ? <div className="proposal-feedback">
          <input value={feedbackNotes[proposal.id] ?? feedback?.note ?? ""} onChange={(event) => setFeedbackNotes((value) => ({ ...value, [proposal.id]: event.target.value }))} placeholder="可选：记录这条候选的优点或问题" maxLength={2000} aria-label="候选质量反馈" />
          <button type="button" data-active={feedback?.rating === "HELPFUL" || undefined} onClick={() => void submitFeedback(proposal, "HELPFUL")} title="标记为有帮助"><ThumbsUp size={13} />有帮助</button>
          <button type="button" data-active={feedback?.rating === "NOT_HELPFUL" || undefined} onClick={() => void submitFeedback(proposal, "NOT_HELPFUL")} title="标记为需改进"><ThumbsDown size={13} />需改进</button>
        </div> : null}
        <div className="ai-actions">{needsInput ? <>{needsInputTargets.length ? needsInputTargets.map((target) => <a className="primary-action" href={target.id === "chapter-plan" ? `/planning#${props.chapterId}` : target.href} key={target.id}>{target.label}</a>) : <a className="primary-action" href="/planning">打开作品规划</a>}<button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />关闭</button></> : <><button type="button" className="primary-action" onClick={() => void decide(proposal, "ACCEPTED")} disabled={decidingProposalId !== null}><Check size={14} />{decidingProposalId === proposal.id ? "处理中…" : proposal.action === "SUMMARIZE" ? "保留摘要" : proposal.action === "DRAFT" ? "应用到正文（整章替换）" : "全部应用到草稿"}</button>{proposal.action !== "SUMMARIZE" ? <button type="button" className="secondary-action" onClick={() => void decide(proposal, "PARTIALLY_ACCEPTED", selectedCandidateText(proposal))} disabled={decidingProposalId !== null || !selectedCandidateText(proposal).trim()}><Check size={14} />应用所选段落</button> : null}<button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />拒绝</button></>}</div>
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
      </> : <div className="proposal-empty"><ShieldCheck size={20} /><div><strong>{pendingReviews.length ? "当前没有正文候选待审核" : "当前没有待审核候选"}</strong><span>{pendingReviews.length ? "一致性审核报告单独保留在下方，不会与应用正文的操作混在一起。" : "AI 生成结果会先停在这里，你确认后才会写入正文。"}</span></div>{pendingReviews.length ? null : <a href="/knowledge/review">进入审核中心</a>}</div>}
    </div>
    {pendingReviews.length ? <section className="consistency-review-list" id="consistency-review-list" aria-label="一致性审核结果">
      <div className="section-heading"><h3><ShieldCheck size={14} />一致性审核结果</h3><span>{pendingReviews.length} 条 · 只读报告</span></div>
      {pendingReviews.map(({ proposal, validation, consistency, consistencyFreshness }) => {
        const needsInput = validation.status === "NEEDS_INPUT";
        const stale = consistencyFreshness === "STALE";
        const text = partialTexts[proposal.id] ?? proposal.outputText;
        const targets = needsInput ? findWritingGapTargets(text) : [];
        return <article className="proposal consistency-review" data-state={stale ? "stale" : needsInput ? "needs-input" : undefined} data-verdict={consistency?.verdict.toLowerCase()} key={proposal.id}>
          <div className="proposal-meta"><strong>一致性审核</strong><span className="proposal-validation" data-status={validation.status.toLowerCase()}>{stale ? `审核已过期 · 原判断：${consistency ? consistencyVerdictLabels[consistency.verdict] : "需补资料"}` : consistency ? consistencyVerdictLabels[consistency.verdict] : needsInput ? "需补资料" : validation.status === "VALID" ? "审核完成" : validation.status === "WARNING" ? "需要检查" : "无效结果"} · {validation.characterCount} 字</span><code>{proposal.promptVersion}</code></div>
          {validation.messages.length ? <div className="proposal-validation-messages">{validation.messages.map((message) => <span key={message}>{message}</span>)}</div> : null}
          {stale ? <div className="consistency-stale-notice"><strong>审核依据已经变化</strong><span>{reviewPolicy === "REQUIRED" ? "严格准入会暂停正文生成，直到按当前内容重新审核。" : "正文修订、章节执行卡、正式设定或审核模型配置已与生成报告时不同。这是一份历史报告，不再阻止当前生成。"}</span></div> : needsInput ? <div className="proposal-needs-input"><strong>当前资料不足以判断准入</strong><span>请先补齐审核报告列出的正式设定，再重新运行审核。</span></div> : null}
          {consistency ? <>
            <p className="consistency-summary">{consistency.summary}</p>
            {consistency.findings.length ? <div className="consistency-findings">{consistency.findings.map((finding, index) => <div className="consistency-finding" data-severity={finding.severity.toLowerCase()} key={`${proposal.id}-${index}`}>
              <strong>{consistencySeverityLabels[finding.severity]}</strong>
              <div>
                <p>{finding.problem || "未提供问题描述"}</p>
                <small>依据：{finding.evidence || "未提供正式依据"}</small>
                <small>建议：{finding.suggestion || "未提供修改建议"}</small>
              </div>
            </div>)}</div> : null}
            {consistency.parseWarnings.length ? <div className="consistency-parse-warnings">{consistency.parseWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
          </> : <pre>{text}</pre>}
          <details className="consistency-raw"><summary>查看原始报告</summary><pre>{text}</pre></details>
          <div className="ai-actions">{stale ? <button type="button" className="primary-action" onClick={() => void runAction("CONSISTENCY_CHECK")} disabled={busy || !reviewProfile?.hasSecret || !canRunConsistencyCheck}><ShieldCheck size={14} />按当前内容重新审核</button> : consistency && (consistency.verdict === "BLOCKED" || consistency.verdict === "REVIEW") ? <a className="primary-action" href={`/planning#${props.chapterId}`}>查看设定与执行卡</a> : null}{!stale && needsInput && targets.length ? targets.map((target) => <a className="primary-action" href={target.id === "chapter-plan" ? `/planning#${props.chapterId}` : target.href} key={target.id}>{target.label}</a>) : null}<button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />关闭审核</button></div>
        </article>;
      })}
    </section> : null}
  </section>;
}
