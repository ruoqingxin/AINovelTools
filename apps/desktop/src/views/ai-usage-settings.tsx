import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, ChartNoAxesCombined, Save, SlidersHorizontal, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCost } from "../lib/ai-cost-estimate";
import {
  errorMessage,
  getAiBudgetSettings,
  getAiUsageSummary,
  saveAiBudgetSettings,
  type AiBudgetSettings,
  type AiUsageCurrencySummary,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

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

function aggregateUsageRows(rows: AiUsageCurrencySummary[] | undefined) {
  const totals = new Map<string, AiUsageCurrencySummary>();
  for (const row of rows ?? []) {
    const total = totals.get(row.currency) ?? {
      currency: row.currency,
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostMicros: 0,
    };
    total.runCount += row.runCount;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    if (row.estimatedCostMicros === null) {
      total.estimatedCostMicros = null;
    } else if (total.estimatedCostMicros !== null) {
      total.estimatedCostMicros += row.estimatedCostMicros;
    }
    totals.set(row.currency, total);
  }
  return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function usageMetricValues(rows: AiUsageCurrencySummary[] | undefined) {
  const tokenCount = rows?.reduce(
    (total, row) => total + row.inputTokens + row.outputTokens,
    0,
  ) ?? 0;
  return {
    tokens: tokenCount.toLocaleString(),
    cost: rows?.length
      ? rows.map((row) => formatCost(row.estimatedCostMicros, row.currency)).join(" / ")
      : "暂无费用记录",
  };
}

export function AiUsageSettings(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const client = useQueryClient();
  const budget = useQuery({ queryKey: ["ai-budget-settings"], queryFn: getAiBudgetSettings });
  const usage = useQuery({ queryKey: ["ai-usage-summary", 30], queryFn: () => getAiUsageSummary(30) });
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
  const recentUsage = aggregateUsageRows(usage.data?.daily);
  const todayMetric = usageMetricValues(todayUsage);
  const recentMetric = usageMetricValues(recentUsage);
  const projectMetric = usageMetricValues(usage.data?.total);
  const todayBudgetCost = todayUsage?.find((row) => row.currency === budgetCurrency)?.estimatedCostMicros;
  const projectBudgetCost = usage.data?.total.find((row) => row.currency === budgetCurrency)?.estimatedCostMicros;
  const dailyBudgetState = budgetState(todayBudgetCost, budgetDraft.dailyLimitMicros);
  const projectBudgetState = budgetState(projectBudgetCost, budgetDraft.projectLimitMicros);

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
        <h2>AI 用量与预算</h2>
        <p>查看不同周期的模型用量，并设置只提醒、不中断任务的软预算。</p>
      </div>
      <a className="secondary-action" href="/jobs#ai-runs"><ArrowUpRight size={14} />运行明细</a>
    </div>
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    <section className="ai-usage-view" aria-label="AI 用量与预算">
      <div className="ai-usage-view-heading">
        <div><strong>用量概览</strong><span>区分今日、近 30 天和项目全部历史，避免把统计周期混在一起。</span></div>
      </div>
      <div className="ai-usage-summary">
        <article className="ai-usage-metric">
          <div><CalendarDays size={14} /><span>今日</span></div>
          <strong>{usage.isPending ? "统计中…" : todayMetric.tokens}<em>{usage.isPending ? "" : "tokens"}</em></strong>
          <small>{usage.isPending ? "正在读取今日用量" : todayMetric.cost}</small>
        </article>
        <article className="ai-usage-metric">
          <div><ChartNoAxesCombined size={14} /><span>近 {usage.data?.days ?? 30} 天</span></div>
          <strong>{usage.isPending ? "统计中…" : recentMetric.tokens}<em>{usage.isPending ? "" : "tokens"}</em></strong>
          <small>{usage.isPending ? "正在读取近期用量" : recentMetric.cost}</small>
        </article>
        <article className="ai-usage-metric">
          <div><WalletCards size={14} /><span>项目累计</span></div>
          <strong>{usage.isPending ? "统计中…" : projectMetric.tokens}<em>{usage.isPending ? "" : "tokens"}</em></strong>
          <small>{usage.isPending ? "正在读取项目累计" : projectMetric.cost}</small>
        </article>
      </div>

      <div className="ai-budget-settings">
        <div className="ai-budget-heading">
          <div><SlidersHorizontal size={14} /><span><strong>软预算</strong><small>只做超支提醒，不会中断正在执行的 AI 任务</small></span></div>
          <span className="ai-budget-state" data-dirty={budgetDirty || undefined}>{budgetDirty ? "有未保存修改" : "当前设置已生效"}</span>
        </div>
        <div className="ai-budget-fields">
          <label><span>预算币种</span><input value={budgetDraft.currency} maxLength={8} onChange={(event) => { setBudgetDraft({ ...budgetDraft, currency: event.target.value }); setNotice(null); }} aria-label="预算币种" /></label>
          <label><span>每日上限</span><span className="ai-budget-input"><b>{budgetCurrency}</b><input type="number" min="0" step="0.01" inputMode="decimal" value={displayBudget(budgetDraft.dailyLimitMicros)} onChange={(event) => { setBudgetDraft({ ...budgetDraft, dailyLimitMicros: parseBudgetMicros(event.target.value) }); setNotice(null); }} placeholder="不限制" aria-label="每日预算上限" /></span></label>
          <label><span>单项目累计上限</span><span className="ai-budget-input"><b>{budgetCurrency}</b><input type="number" min="0" step="0.01" inputMode="decimal" value={displayBudget(budgetDraft.projectLimitMicros)} onChange={(event) => { setBudgetDraft({ ...budgetDraft, projectLimitMicros: parseBudgetMicros(event.target.value) }); setNotice(null); }} placeholder="不限制" aria-label="项目预算上限" /></span></label>
          <button type="button" className="primary-action" onClick={() => void saveBudget()} disabled={budgetSaving || !budgetDirty}><Save size={14} />{budgetSaving ? "保存中…" : "保存预算"}</button>
        </div>
        {dailyBudgetState && dailyBudgetState !== "normal" ? <span className="ai-budget-warning" data-state={dailyBudgetState}>今日估算费用已达到每日预算的 {Math.round((todayBudgetCost! / budgetDraft.dailyLimitMicros!) * 100)}%</span> : null}
        {projectBudgetState && projectBudgetState !== "normal" ? <span className="ai-budget-warning" data-state={projectBudgetState}>项目累计估算费用已达到项目预算的 {Math.round((projectBudgetCost! / budgetDraft.projectLimitMicros!) * 100)}%</span> : null}
      </div>
      <p className="ai-usage-note">DeepSeek Flash 返回缓存明细时按本次 API 用量与调用时价格计算；未返回明细或其他模型仍按 token 估算，最终以服务商账单为准。</p>
    </section>
  </div>;
}
