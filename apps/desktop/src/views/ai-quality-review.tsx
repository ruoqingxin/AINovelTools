import { useQuery } from "@tanstack/react-query";
import { errorMessage, getAiQualitySummary } from "../lib/tauri-client";

export const QUALITY_DAYS = 90;
export const QUALITY_GROUP_LIMIT = 20;

const RUN_ACTION_LABELS: Record<string, string> = {
  DRAFT: "整章创作",
  CONTINUE: "续写",
  REWRITE: "重写",
  POLISH: "润色",
  SUMMARIZE: "摘要",
  CONSISTENCY_CHECK: "一致性审核",
  workDesign: "作品设定",
  outline: "大纲主线",
  volumePlanning: "分卷规划",
  chapterSplit: "章节拆分",
  chapterPlan: "章节规划",
  consistencyReview: "一致性审核",
  writing: "正文书写",
  knowledgeExtraction: "知识提炼",
};

function percentage(value: number, total: number) {
  if (!total) return null;
  return Math.round((value / total) * 100);
}

export function AiQualityReview() {
  const quality = useQuery({
    queryKey: ["ai-quality-summary", QUALITY_GROUP_LIMIT, QUALITY_DAYS],
    queryFn: () => getAiQualitySummary(QUALITY_GROUP_LIMIT, QUALITY_DAYS),
  });

  return <section className="ai-usage-view" aria-label="AI 质量回顾">
    <div className="ai-usage-view-heading">
      <div><strong>质量回顾</strong><span>只统计最近 {QUALITY_DAYS} 天、样本最多的 {QUALITY_GROUP_LIMIT} 组，避免长期数据持续堆积。</span></div>
      <small>{quality.data ? `${quality.data.totalProposals} 条候选 · ${quality.data.totalRated} 条评价 · 最近 ${QUALITY_DAYS} 天` : quality.isPending ? "统计中…" : "无数据"}</small>
    </div>
    {quality.isError ? <p className="project-error" role="alert">质量统计加载失败：{errorMessage(quality.error)}</p> : quality.data?.groups.length ? <div className="ai-quality-list">
      <div className="ai-quality-table-head"><span>任务与模型</span><span>有帮助</span><span>资料与校验</span><span>采用</span></div>
      {quality.data.groups.map((group) => <article className="ai-quality-row" key={`${group.taskKey}:${group.action}:${group.promptVersion}:${group.profileName}`}>
        <div><strong>{RUN_ACTION_LABELS[group.action] ?? group.taskKey} · {group.profileName}</strong><small>{group.promptVersion} · {group.proposalCount} 条候选</small></div>
        <span><small>有帮助</small><strong>{percentage(group.helpfulCount, group.ratedCount) ?? "—"}{percentage(group.helpfulCount, group.ratedCount) === null ? "" : "%"}</strong></span>
        <span data-warning={group.warningCount + group.needsInputCount + group.invalidCount > 0 || undefined}><small>需补资料 {group.needsInputCount}</small><strong>校验问题 {percentage(group.warningCount + group.invalidCount, group.proposalCount) ?? 0}%</strong></span>
        <span><small>采用率</small><strong>{percentage(group.acceptedCount, group.proposalCount) ?? 0}%</strong></span>
      </article>)}
    </div> : quality.isPending ? <p className="plan-empty">正在读取质量统计…</p> : <p className="plan-empty">生成并评价正文候选后，这里会显示质量对比。</p>}
  </section>;
}
