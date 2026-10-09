import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, ChartNoAxesCombined, RotateCcw, Save, SlidersHorizontal, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCost } from "../lib/ai-cost-estimate";
import { AI_TASK_DEFINITIONS } from "../lib/ai-task-preferences";
import {
  errorMessage,
  getAiBudgetSettings,
  getAiUsageSummary,
  getProjectAiTaskOverrides,
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
    runs: rows?.reduce((total, row) => total + row.runCount, 0) ?? 0,
    cost: rows?.length
      ? rows.map((row) => formatCost(row.estimatedCostMicros, row.currency)).join(" / ")
      : "暂无费用记录",
  };
}

export function AiUsageSettings(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const client = useQueryClient();
  const [days, setDays] = useState(30);
  const project = useQuery({ queryKey: ["project-ai-task-overrides"], queryFn: getProjectAiTaskOverrides });
  const budget = useQuery({ queryKey: ["ai-budget-settings"], queryFn: getAiBudgetSettings });
  const usage = useQuery({ queryKey: ["ai-usage-summary", days], queryFn: () => getAiUsageSummary(days), enabled: project.data?.available === true });
  const [budgetDraft, setBudgetDraft] = useState<AiBudgetSettings>({
    currency: "USD",
    dailyLimitMicros: null,
    projectLimitMicros: null,
  });
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dailyInput, setDailyInput] = useState("");
  const [projectInput, setProjectInput] = useState("");

  useEffect(() => {
    if (budget.data) {
      setBudgetDraft(budget.data);
      setDailyInput(displayBudget(budget.data.dailyLimitMicros));
      setProjectInput(displayBudget(budget.data.projectLimitMicros));
    }
  }, [budget.data]);

  const validAmount = (value: string) => !value.trim() || (Number.isFinite(Number(value)) && Math.round(Number(value) * 1_000_000) > 0 && Number.isSafeInteger(Math.round(Number(value) * 1_000_000)));
  const budgetInvalid = !validAmount(dailyInput) || !validAmount(projectInput);
  const budgetDirty = budget.data ? budgetSignature(budgetDraft) !== budgetSignature(budget.data) || dailyInput !== displayBudget(budget.data.dailyLimitMicros) || projectInput !== displayBudget(budget.data.projectLimitMicros) : false;
  useUnsavedChangesGuard(budgetDirty, "当前预算设置有未保存修改。");

  useEffect(() => {
    props.onDirtyChange?.(budgetDirty);
    return () => props.onDirtyChange?.(false);
  }, [budgetDirty, props.onDirtyChange]);

  const budgetCurrency = budgetDraft.currency.trim().toUpperCase() || "USD";
  const todayUsage = aggregateUsageRows(usage.data?.daily.filter((row) => row.date === todayLocalDate()));
  const recentUsage = aggregateUsageRows(usage.data?.daily);
  const todayMetric = usageMetricValues(todayUsage);
  const recentMetric = usageMetricValues(recentUsage);
  const projectMetric = usageMetricValues(usage.data?.total);
  const savedCurrency = budget.data?.currency ?? "USD";
  const todayBudgetCost = todayUsage.find((row) => row.currency === savedCurrency)?.estimatedCostMicros;
  const projectBudgetCost = usage.data?.total.find((row) => row.currency === savedCurrency)?.estimatedCostMicros;
  const dailyBudgetState = budgetState(todayBudgetCost, budget.data?.dailyLimitMicros ?? null);
  const projectBudgetState = budgetState(projectBudgetCost, budget.data?.projectLimitMicros ?? null);

  async function saveBudget() {
    if (budgetInvalid || !budget.data) return;
    setBudgetSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveAiBudgetSettings({ ...budgetDraft, currency: budgetCurrency });
      setBudgetDraft(saved);
      setDailyInput(displayBudget(saved.dailyLimitMicros));
      setProjectInput(displayBudget(saved.projectLimitMicros));
      client.setQueryData(["ai-budget-settings"], saved);
      setNotice("AI 软预算已保存，超出上限时仅提示，不会中断生成");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBudgetSaving(false);
    }
  }

  function resetBudget() {
    if (!budget.data) return;
    setBudgetDraft(budget.data);
    setDailyInput(displayBudget(budget.data.dailyLimitMicros));
    setProjectInput(displayBudget(budget.data.projectLimitMicros));
    setNotice(null);
  }

  function renderProgress(label: string, cost: number | null | undefined, limit: number | null) {
    if (!limit) return null;
    const percent = cost == null ? null : Math.round(cost / limit * 100);
    return <div className="settings-budget-progress"><div><span>{label}</span><strong>{cost == null ? "费用尚不可估算" : `${formatCost(cost, savedCurrency)} / ${formatCost(limit, savedCurrency)}`}</strong></div><progress max={100} value={Math.min(percent ?? 0, 100)} aria-label={label} /><small>{percent == null ? "需同币种用量及模型单价" : `已使用 ${percent}%`}</small></div>;
  }

  return <div className="settings-content">
    <div className="settings-content-heading">
      <div>
        <span className="settings-scope-label">用量按作品统计 · 预算阈值全局共用</span>
        <h2>AI 用量与预算</h2>
        <p>费用为估算值；软预算仅提醒，不中断 AI 任务。</p>
      </div>
      <a className="secondary-action" href="/jobs#ai-runs"><ArrowUpRight size={14} />运行明细</a>
    </div>
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    {budget.isError ? <p className="project-error" role="alert">读取预算失败：{errorMessage(budget.error)} <button className="settings-text-link" onClick={() => void budget.refetch()}>重试</button></p> : null}
    {project.isError || usage.isError ? <p className="project-error" role="alert">读取用量失败：{errorMessage(project.error ?? usage.error)} <button className="settings-text-link" onClick={() => { void project.refetch(); void usage.refetch(); }}>重试</button></p> : null}
    <section className="ai-usage-view" aria-label="AI 用量与预算">
      <div className="ai-usage-view-heading">
        <div><strong>用量概览</strong><span>{project.data?.available ? "当前作品" : project.isPending ? "正在读取作品状态…" : "未打开作品 · 暂无用量统计"}</span></div>
        <div className="settings-period-switch" role="group" aria-label="用量统计周期">{[7, 30, 90].map((period) => <button type="button" key={period} aria-pressed={days === period} onClick={() => setDays(period)}>{period} 天</button>)}</div>
      </div>
      <div className="ai-usage-summary">
        <article className="ai-usage-metric">
          <div><CalendarDays size={14} /><span>今日</span></div>
          <strong>{usage.isFetching ? "统计中…" : usage.isError ? "--" : todayMetric.tokens}<em>tokens</em></strong>
          <small>{usage.isError ? "读取失败" : `${todayMetric.runs} 次调用 · ${todayMetric.cost}`}</small>
        </article>
        <article className="ai-usage-metric">
          <div><ChartNoAxesCombined size={14} /><span>近 {days} 天</span></div>
          <strong>{usage.isFetching ? "统计中…" : usage.isError ? "--" : recentMetric.tokens}<em>tokens</em></strong>
          <small>{usage.isError ? "读取失败" : `${recentMetric.runs} 次调用 · ${recentMetric.cost}`}</small>
        </article>
        <article className="ai-usage-metric">
          <div><WalletCards size={14} /><span>项目累计</span></div>
          <strong>{usage.isFetching ? "统计中…" : usage.isError ? "--" : projectMetric.tokens}<em>tokens</em></strong>
          <small>{usage.isError ? "读取失败" : `${projectMetric.runs} 次调用 · ${projectMetric.cost}`}</small>
        </article>
      </div>

      <div className="ai-budget-settings">
        <div className="ai-budget-heading">
          <div><SlidersHorizontal size={14} /><span><strong>软预算</strong><small>只做超支提醒，不会中断正在执行的 AI 任务</small></span></div>
          <span className="settings-status" data-dirty={budgetDirty || undefined}>{budget.isPending ? "正在读取…" : budget.isError ? "读取失败" : budgetDirty ? "未保存修改" : "当前设置已生效"}</span>
        </div>
        <fieldset className="settings-fields" disabled={budgetSaving || !budget.data || budget.isError}><div className="ai-budget-fields">
          <label><span>预算币种</span><select value={budgetDraft.currency} onChange={(event) => { setBudgetDraft({ ...budgetDraft, currency: event.target.value }); setNotice(null); }} aria-label="预算币种"><option value="USD">USD · 美元</option><option value="CNY">CNY · 人民币</option>{!["USD", "CNY"].includes(budgetDraft.currency) ? <option value={budgetDraft.currency}>{budgetDraft.currency}</option> : null}</select></label>
          <label><span>每日上限</span><span className="ai-budget-input"><b>{budgetCurrency}</b><input type="number" min="0.000001" step="any" inputMode="decimal" value={dailyInput} onChange={(event) => { setDailyInput(event.target.value); setBudgetDraft({ ...budgetDraft, dailyLimitMicros: parseBudgetMicros(event.target.value) }); setNotice(null); }} placeholder="不限制" aria-label="每日预算上限" aria-invalid={!validAmount(dailyInput)} /></span></label>
          <label><span>单项目累计上限</span><span className="ai-budget-input"><b>{budgetCurrency}</b><input type="number" min="0.000001" step="any" inputMode="decimal" value={projectInput} onChange={(event) => { setProjectInput(event.target.value); setBudgetDraft({ ...budgetDraft, projectLimitMicros: parseBudgetMicros(event.target.value) }); setNotice(null); }} placeholder="不限制" aria-label="项目预算上限" aria-invalid={!validAmount(projectInput)} /></span></label>
        </div></fieldset>
        <p className="settings-inline-note">达到 80% 时提醒；留空不设上限。仅核算所选币种，不进行汇率换算。</p>
        {budgetInvalid ? <p className="settings-field-warning" role="alert">预算须为大于 0 的有效金额；取消限制请留空。</p> : null}
        <div className="settings-budget-progress-grid">{renderProgress("今日预算", todayBudgetCost, budget.data?.dailyLimitMicros ?? null)}{renderProgress("作品累计预算", projectBudgetCost, budget.data?.projectLimitMicros ?? null)}</div>
        {dailyBudgetState && dailyBudgetState !== "normal" ? <span className="ai-budget-warning" data-state={dailyBudgetState}>今日估算费用已达到每日预算的 {Math.round((todayBudgetCost! / budget.data!.dailyLimitMicros!) * 100)}%</span> : null}
        {projectBudgetState && projectBudgetState !== "normal" ? <span className="ai-budget-warning" data-state={projectBudgetState}>项目累计估算费用已达到项目预算的 {Math.round((projectBudgetCost! / budget.data!.projectLimitMicros!) * 100)}%</span> : null}
        <div className="settings-save-row"><button type="button" className="primary-action" onClick={() => void saveBudget()} disabled={budgetSaving || !budgetDirty || budgetInvalid || budget.isError || !budget.data}><Save size={14} />{budgetSaving ? "保存中…" : "保存预算"}</button>{budgetDirty ? <button type="button" className="secondary-action" onClick={resetBudget} disabled={budgetSaving}><RotateCcw size={14} />撤销修改</button> : null}</div>
      </div>
      {usage.data?.byTask.length ? <section className="settings-usage-breakdown"><div className="settings-section-heading"><h3>任务费用明细</h3><span className="settings-status">项目全部历史</span></div><div className="settings-table-scroll"><table><thead><tr><th>任务</th><th>调用次数</th><th>输入 tokens</th><th>输出 tokens</th><th>估算费用</th></tr></thead><tbody>{usage.data.byTask.map((row) => <tr key={`${row.taskKey}-${row.currency}`}><td>{AI_TASK_DEFINITIONS.find((task) => task.key === row.taskKey)?.label ?? row.taskKey}</td><td>{row.runCount.toLocaleString()}</td><td>{row.inputTokens.toLocaleString()}</td><td>{row.outputTokens.toLocaleString()}</td><td>{formatCost(row.estimatedCostMicros, row.currency)}</td></tr>)}</tbody></table></div></section> : null}
      <p className="ai-usage-note">DeepSeek Flash 返回缓存明细时按本次 API 用量与调用时价格计算；未返回明细或其他模型仍按 token 估算，最终以服务商账单为准。</p>
    </section>
  </div>;
}
