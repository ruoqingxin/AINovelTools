import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCost } from "../lib/ai-cost-estimate";
import {
  errorMessage,
  getAiBudgetSettings,
  getAiQualitySummary,
  getAiUsageSummary,
  listAiRuns,
  saveAiBudgetSettings,
  type AiBudgetSettings,
  type AiRun,
  type AiUsageCurrencySummary,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

const RUN_STATUS_LABELS: Record<string, string> = {
  RUNNING: "执行中",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

const RUN_ACTION_LABELS: Record<string, string> = {
  DRAFT: "整章创作",
  CONTINUE: "续写",
  REWRITE: "重写",
  POLISH: "润色",
  SUMMARIZE: "摘要",
  workDesign: "作品设定",
  outline: "大纲主线",
  volumePlanning: "分卷规划",
  chapterSplit: "章节拆分",
  chapterPlan: "章节规划",
  writing: "正文书写",
  knowledgeExtraction: "知识提炼",
};

function parseBudgetMicros(value: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 1_000_000);
}

function displayBudget(micros: number | null) {
  return micros === null ? "" : String(micros / 1_000_000);
}

function budgetSignature(settings: AiBudgetSettings) {
  return JSON.stringify({
    currency: settings.currency.trim().toUpperCase(),
    dailyLimitMicros: settings.dailyLimitMicros,
    projectLimitMicros: settings.projectLimitMicros,
  });
}

function budgetState(costMicros: number | null | undefined, limitMicros: number | null) {
  if (costMicros === null || costMicros === undefined || !limitMicros) return null;
  if (costMicros >= limitMicros) return "over";
  if (costMicros >= limitMicros * 0.8) return "near";
  return "normal";
}

function todayLocalDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUsageRows(rows: AiUsageCurrencySummary[] | undefined) {
  if (!rows?.length) return "暂无记录";
  return rows
    .map((row) => `${(row.inputTokens + row.outputTokens).toLocaleString()} tokens · ${formatCost(row.estimatedCostMicros, row.currency)}`)
    .join(" / ");
}

function formatRunDuration(createdAt: string, finishedAt: string | null) {
  if (!finishedAt) return null;
  const startedAt = Date.parse(createdAt);
  const completedAt = Date.parse(finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return null;
  const totalSeconds = Math.max(1, Math.round((completedAt - startedAt) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function costTotalsByCurrency(runs: AiRun[] | undefined) {
  const totals = new Map<string, number>();
  for (const run of runs ?? []) {
    if (run.estimatedCostMicros === null) continue;
    totals.set(run.priceCurrency, (totals.get(run.priceCurrency) ?? 0) + run.estimatedCostMicros);
  }
  return [...totals.entries()];
}

function percentage(value: number, total: number) {
  if (!total) return null;
  return Math.round((value / total) * 100);
}

export function AiUsageSettings(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const client = useQueryClient();
  const budget = useQuery({ queryKey: ["ai-budget-settings"], queryFn: getAiBudgetSettings });
  const runs = useQuery({ queryKey: ["ai-runs", 80], queryFn: () => listAiRuns(80) });
  const usage = useQuery({ queryKey: ["ai-usage-summary", 30], queryFn: () => getAiUsageSummary(30) });
  const quality = useQuery({ queryKey: ["ai-quality-summary", 20], queryFn: () => getAiQualitySummary(20) });
  const [budgetDraft, setBudgetDraft] = useState<AiBudgetSettings>({
    currency: "USD",
    dailyLimitMicros: null,
    projectLimitMicros: null,
  });
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (budget.data) setBudgetDraft(budget.data);
  }, [budget.data]);

  const budgetDirty = budget.data ? budgetSignature(budgetDraft) !== budgetSignature(budget.data) : false;
  useUnsavedChangesGuard(budgetDirty, "当前预算设置有未保存修改。");

  useEffect(() => {
    props.onDirtyChange?.(budgetDirty);
    return () => props.onDirtyChange?.(false);
  }, [budgetDirty, props.onDirtyChange]);

  const budgetCurrency = budgetDraft.currency.trim().toUpperCase() || "USD";
  const todayUsage = usage.data?.daily.filter((row) => row.date === todayLocalDate());
  const todayBudgetCost = todayUsage?.find((row) => row.currency === budgetCurrency)?.estimatedCostMicros;
  const projectBudgetCost = usage.data?.total.find((row) => row.currency === budgetCurrency)?.estimatedCostMicros;
  const dailyBudgetState = budgetState(todayBudgetCost, budgetDraft.dailyLimitMicros);
  const projectBudgetState = budgetState(projectBudgetCost, budgetDraft.projectLimitMicros);
  const totalEstimatedTokens = runs.data?.reduce(
    (total, run) => total + run.estimatedInputTokens + run.estimatedOutputTokens,
    0,
  ) ?? 0;
  const runCostTotals = costTotalsByCurrency(runs.data);

  async function saveBudget() {
    setBudgetSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveAiBudgetSettings({ ...budgetDraft, currency: budgetCurrency });
      setBudgetDraft(saved);
      client.setQueryData(["ai-budget-settings"], saved);
      setNotice("AI 软预算已保存，超出上限时仅提示，不会中断生成");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBudgetSaving(false);
    }
  }

  return <div className="settings-content">
    <div className="settings-content-heading">
      <div>
        <h2>预算与记录</h2>
        <p>集中查看模型用量、软预算、候选质量和最近运行记录。</p>
      </div>
    </div>
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    <section className="ai-run-history">
      <div className="ai-task-routing-heading">
        <div><strong>最近 AI 运行</strong><span>统一记录规划、正文和知识提炼的最终模型、尝试次数、主备切换与费用。</span></div>
        <small>{runs.data?.length ?? 0} 条 · 累计约 {totalEstimatedTokens.toLocaleString()} tokens{runCostTotals.length ? ` · ${runCostTotals.map(([currency, micros]) => formatCost(micros, currency)).join(" / ")}` : ""}</small>
      </div>
      <div className="ai-usage-summary">
        <div><span>今日</span><strong>{usage.isPending ? "统计中…" : formatUsageRows(todayUsage)}</strong></div>
        <div><span>近 {usage.data?.days ?? 30} 天</span><strong>{usage.isPending ? "统计中…" : formatUsageRows(usage.data?.total)}</strong></div>
        <div><span>项目累计</span><strong>{usage.isPending ? "统计中…" : formatUsageRows(usage.data?.total)}</strong></div>
      </div>
      <div className="ai-budget-settings">
        <div className="ai-budget-fields">
          <label><span>预算币种</span><input value={budgetDraft.currency} maxLength={8} onChange={(event) => { setBudgetDraft({ ...budgetDraft, currency: event.target.value }); setNotice(null); }} aria-label="预算币种" /></label>
          <label><span>每日上限</span><input type="number" min="0" step="0.01" inputMode="decimal" value={displayBudget(budgetDraft.dailyLimitMicros)} onChange={(event) => { setBudgetDraft({ ...budgetDraft, dailyLimitMicros: parseBudgetMicros(event.target.value) }); setNotice(null); }} placeholder="不限制" aria-label="每日预算上限" /></label>
          <label><span>单项目累计上限</span><input type="number" min="0" step="0.01" inputMode="decimal" value={displayBudget(budgetDraft.projectLimitMicros)} onChange={(event) => { setBudgetDraft({ ...budgetDraft, projectLimitMicros: parseBudgetMicros(event.target.value) }); setNotice(null); }} placeholder="不限制" aria-label="项目预算上限" /></label>
          <button type="button" className="secondary-action" onClick={() => void saveBudget()} disabled={budgetSaving || !budgetDirty}><Save size={14} />{budgetSaving ? "保存中…" : "保存预算"}</button>
        </div>
        {dailyBudgetState && dailyBudgetState !== "normal" ? <span className="ai-budget-warning" data-state={dailyBudgetState}>今日估算费用已达到每日预算的 {Math.round((todayBudgetCost! / budgetDraft.dailyLimitMicros!) * 100)}%</span> : null}
        {projectBudgetState && projectBudgetState !== "normal" ? <span className="ai-budget-warning" data-state={projectBudgetState}>项目累计估算费用已达到项目预算的 {Math.round((projectBudgetCost! / budgetDraft.projectLimitMicros!) * 100)}%</span> : null}
      </div>
      <p className="ai-usage-note">费用按模型单价和估算 token 计算，仅用于预算参考，不代表服务商最终账单。</p>
      <div className="ai-quality-review">
        <div className="ai-task-routing-heading">
          <div><strong>质量回顾</strong><span>按模型和提示词版本汇总正文候选；样本不足时不据此自动切换配置。</span></div>
          <small>{quality.data ? `${quality.data.totalProposals} 条候选 · ${quality.data.totalRated} 条评价` : quality.isPending ? "统计中…" : "无数据"}</small>
        </div>
        {quality.isError ? <p className="project-error">质量统计加载失败：{errorMessage(quality.error)}</p> : quality.data?.groups.length ? <div className="ai-quality-list">
          {quality.data.groups.map((group) => <article className="ai-quality-row" key={`${group.taskKey}:${group.action}:${group.promptVersion}:${group.profileName}`}>
            <div><strong>{RUN_ACTION_LABELS[group.action] ?? group.taskKey} · {group.profileName}</strong><small>{group.promptVersion} · {group.proposalCount} 条候选</small></div>
            <span>有帮助 {percentage(group.helpfulCount, group.ratedCount) ?? "—"}{percentage(group.helpfulCount, group.ratedCount) === null ? "" : "%"}</span>
            <span data-warning={group.warningCount + group.needsInputCount + group.invalidCount > 0 || undefined}>需补资料 {group.needsInputCount} · 校验问题 {percentage(group.warningCount + group.invalidCount, group.proposalCount) ?? 0}%</span>
            <span>采用 {percentage(group.acceptedCount, group.proposalCount) ?? 0}%</span>
          </article>)}
        </div> : <p className="plan-empty">生成并评价正文候选后，这里会显示质量对比。</p>}
      </div>
      {runs.isPending ? <p className="plan-empty">正在加载运行记录…</p> : runs.isError ? <p className="project-error">运行记录加载失败：{errorMessage(runs.error)}</p> : runs.data?.length ? <div className="ai-run-list">
        {runs.data.map((run) => {
          const duration = formatRunDuration(run.createdAt, run.finishedAt);
          return <article className="ai-run-row" key={run.id}>
            <div><strong>{RUN_ACTION_LABELS[run.action] ?? run.taskKey} · {run.chapterTitle}</strong><small>{new Date(run.createdAt).toLocaleString()} · {run.profileName} · {run.source === "PLANNING" ? "规划" : run.source === "KNOWLEDGE_EXTRACTION" ? "知识提炼" : "正文"}</small></div>
            <span className={`job-status job-${run.status.toLowerCase()}`}>{RUN_STATUS_LABELS[run.status] ?? run.status}</span>
            <small>尝试 {run.attemptCount}{duration ? ` · 耗时 ${duration}` : ""} · 输入约 {run.estimatedInputTokens.toLocaleString()} / 输出约 {run.estimatedOutputTokens.toLocaleString()} tokens · {formatCost(run.estimatedCostMicros, run.priceCurrency)}{run.retryReason ? ` · 回退原因 ${run.retryReason}` : ""}{run.errorCode ? ` · ${run.errorCode}` : ""}</small>
          </article>;
        })}
      </div> : <p className="plan-empty">当前项目还没有 AI 运行记录。</p>}
    </section>
  </div>;
}
