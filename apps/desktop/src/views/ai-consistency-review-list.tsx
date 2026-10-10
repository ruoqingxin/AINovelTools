import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { errorMessage, getConsistencyReviewTrace, type AiConsistencySeverity, type AiConsistencyVerdict, type AiProposal, type AiProposalReview, type ReviewTrace, type WritingReviewPolicy } from "../lib/tauri-client";
import { findWritingGapTargets } from "../lib/writing-readiness";

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
const reviewStatusLabels: Record<ReviewTrace["modelFindings"][number]["status"], string> = {
  PASS: "通过",
  NOTICE: "提示",
  WARNING: "警告",
  BLOCK: "阻断",
  UNKNOWN: "无法确认",
};

function ReviewTraceDetails(props: { proposalId: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const trace = useQuery({
    queryKey: ["review-trace", props.proposalId],
    queryFn: () => getConsistencyReviewTrace(props.proposalId),
    enabled: props.active && open,
  });
  return <details className="consistency-trace" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>查看声明与依据</summary>
    {open ? trace.isPending ? <p className="consistency-trace-loading">正在读取声明与证据…</p>
      : trace.isError ? <p className="project-error" role="alert">审核依据加载失败：{errorMessage(trace.error)}</p>
        : <ReviewTraceContent data={trace.data} /> : null}
  </details>;
}

function ReviewTraceContent({ data }: { data: ReviewTrace }) {
  const evidenceByClaim = new Map<string, ReviewTrace["evidence"]>();
  for (const item of data.evidence) {
    const current = evidenceByClaim.get(item.claimId) ?? [];
    current.push(item);
    evidenceByClaim.set(item.claimId, current);
  }
  const findings = [...data.deterministicFindings, ...data.modelFindings];
  return <>
    <p>{data.claims.length} 条声明 · {data.evidence.length} 条证据{data.omittedItems.length ? ` · ${data.omittedItems.length} 项未检查` : ""}</p>
    {data.claims.length ? <div className="consistency-claims">
      {data.claims.map((claim) => {
        const claimFindings = findings.filter((finding) => finding.claimId === claim.id);
        const claimEvidence = evidenceByClaim.get(claim.id) ?? [];
        return <article key={claim.id}>
          <div className="proposal-meta"><strong>{claim.claimType}</strong><span>重要性 {claim.importance} · 置信度 {claim.confidence}</span></div>
          <blockquote>{claim.quote}</blockquote>
          <p>{claim.subject} · {claim.predicate} · {claim.object}</p>
          {claimFindings.length ? <div className="consistency-claim-findings">{claimFindings.map((finding) => <span data-status={finding.status.toLowerCase()} key={finding.id}>{reviewStatusLabels[finding.status]} · {finding.sourceKind === "RULE" ? `规则 ${finding.ruleId ?? ""}` : finding.sourceKind === "MERGED" ? "规则与模型合并" : "模型复核"}</span>)}</div> : null}
          {claimEvidence.length ? <ul>{claimEvidence.map((evidence) => <li key={evidence.id}><small>{evidence.sourceKind} · {evidence.authority} · {evidence.sourceRevision}</small><p>{evidence.excerpt}</p></li>)}</ul> : <p className="consistency-no-evidence">没有找到与这条声明对应的正式证据。</p>}
        </article>;
      })}
    </div> : <p className="consistency-no-evidence">提取阶段没有保留可逐字定位的声明。</p>}
    {data.omittedItems.length ? <div className="consistency-omitted"><strong>未检查项</strong>{data.omittedItems.map((item, index) => <p key={`${item.itemType}-${index}`}><span>{item.label}</span>{item.reason}</p>)}</div> : null}
  </>;
}

export function AiConsistencyReviewList(props: {
  reviews: AiProposalReview[]; active: boolean; reviewingManuscript: boolean;
  partialTexts: Record<string, string>; reviewPolicy: WritingReviewPolicy; generationLocked: boolean;
  hasReviewSecret: boolean; canRunConsistencyCheck: boolean; decidingProposalId: string | null;
  chapterId: string; onReturnToEditor?: () => void; onOpenChapterPlan?: () => void;
  onRunReview: () => void; onCloseReview: (proposal: AiProposal) => void;
}) {
  const { reviews: pendingReviews, active, reviewingManuscript, partialTexts, reviewPolicy,
    generationLocked, canRunConsistencyCheck, decidingProposalId } = props;
  return <>{pendingReviews.length ? <section className="consistency-review-list" id="consistency-review-list" aria-label={reviewingManuscript ? "正文候选审核结果" : "创作准入结果"}>
      <div className="section-heading"><h3><ShieldCheck size={14} />{reviewingManuscript ? "正文候选审核结果" : "创作准入结果"}</h3><span>{pendingReviews.length} 条 · 只读报告</span></div>
      {pendingReviews.map(({ proposal, validation, consistency, consistencyFreshness, hasReviewTrace }) => {
        const needsInput = validation.status === "NEEDS_INPUT";
        const stale = consistencyFreshness === "STALE";
        const text = partialTexts[proposal.id] ?? proposal.outputText;
        const targets = needsInput ? findWritingGapTargets(text) : [];
        return <article className="proposal consistency-review" data-state={stale ? "stale" : needsInput ? "needs-input" : undefined} data-verdict={consistency?.verdict.toLowerCase()} key={proposal.id}>
          <div className="proposal-meta"><strong>{reviewingManuscript ? "正文候选审核" : "创作准入"}</strong><span className="proposal-validation" data-status={validation.status.toLowerCase()}>{stale ? `审核已过期 · 原判断：${consistency ? consistencyVerdictLabels[consistency.verdict] : "需补资料"}` : consistency ? consistencyVerdictLabels[consistency.verdict] : needsInput ? "需补资料" : validation.status === "VALID" ? "审核完成" : validation.status === "WARNING" ? "需要检查" : "无效结果"} · {validation.characterCount} 字</span></div>
          {validation.messages.length ? <div className="proposal-validation-messages">{validation.messages.map((message) => <span key={message}>{message}</span>)}</div> : null}
          {stale ? <div className="consistency-stale-notice"><strong>审核依据已经变化</strong><span>{reviewingManuscript ? "候选内容、章节执行卡、正式依据或审核模型配置已与生成报告时不同。这份候选审核报告仅作历史参考。" : reviewPolicy === "REQUIRED" ? "严格准入会暂停正文生成，直到按当前内容重新审核。" : "章节执行卡、正式依据或审核模型配置已与生成报告时不同。这份准入报告不再参与写作准入。"}</span></div> : needsInput ? <div className="proposal-needs-input"><strong>{reviewingManuscript ? "当前资料不足以完成候选审核" : "当前资料不足以判断准入"}</strong><span>请先补齐审核报告列出的正式设定，再重新运行审核。</span></div> : null}
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
          {hasReviewTrace ? <ReviewTraceDetails proposalId={proposal.id} active={active} /> : null}
          <details className="consistency-raw"><summary>查看原始报告</summary><pre>{text}</pre></details>
          <div className="ai-actions">
            {stale ? <button type="button" className="primary-action" onClick={props.onRunReview} disabled={generationLocked || !props.hasReviewSecret || !canRunConsistencyCheck}><ShieldCheck size={14} />按当前内容重新审核</button>
              : consistency && (consistency.verdict === "BLOCKED" || consistency.verdict === "REVIEW")
                ? reviewingManuscript
                  ? props.onReturnToEditor
                    ? <button type="button" className="primary-action" onClick={props.onReturnToEditor}>返回编辑</button>
                    : <a className="primary-action" href={`/writing#${props.chapterId}`}>返回候选区修改</a>
                  : props.onOpenChapterPlan
                    ? <button type="button" className="primary-action" onClick={props.onOpenChapterPlan}>查看本章计划</button>
                    : <a className="primary-action" href={`/chapters#${props.chapterId}`}>查看设定与执行卡</a>
                : null}
            {!stale && needsInput && targets.length ? targets.map((target) =>
              target.id === "chapter-plan" && props.onOpenChapterPlan
                ? <button type="button" className="primary-action" onClick={props.onOpenChapterPlan} key={target.id}>{target.label}</button>
                : <a className="primary-action" href={target.id === "chapter-plan" ? `/chapters#${props.chapterId}` : target.href} key={target.id}>{target.label}</a>,
            ) : null}
            <button type="button" className="secondary-action" onClick={() => props.onCloseReview(proposal)} disabled={decidingProposalId !== null}><Trash2 size={14} />关闭审核</button>
          </div>
        </article>;
      })}
    </section> : <div className="proposal-empty review-empty"><ShieldCheck size={20} /><div><strong>{reviewingManuscript ? "当前没有候选审核报告" : "当前没有创作准入报告"}</strong><span>{reviewingManuscript ? "候选区写作或修改后可反复审核；人物状态、规则、时间线和叙述问题会集中显示在这里。" : "检查后会明确当前是否可以生成正文，以及还需要补齐哪些设定。"}</span></div></div>}</>;
}
