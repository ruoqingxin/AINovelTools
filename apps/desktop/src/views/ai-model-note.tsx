import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { estimateNextRunCost, nextRunCostLabel } from "../lib/ai-cost-estimate";
import {
  describeTaskPreferenceDifferences,
  type AiTaskKey,
} from "../lib/ai-task-preferences";
import {
  getAiBudgetSettings,
  getAiUsageSummary,
  type AiTaskPreference,
  type ModelProfile,
} from "../lib/tauri-client";

export function AiModelNote(props: {
  taskLabel: string;
  taskKey?: AiTaskKey;
  profile: ModelProfile | undefined;
  preference?: AiTaskPreference;
  runMultiplier?: number;
}) {
  const usage = useQuery({
    queryKey: ["ai-usage-summary", 30],
    queryFn: () => getAiUsageSummary(30),
    enabled: Boolean(props.taskKey),
  });
  const budget = useQuery({
    queryKey: ["ai-budget-settings"],
    queryFn: getAiBudgetSettings,
    enabled: Boolean(props.taskKey),
  });
  const modelState = !props.profile
    ? "missing"
    : props.profile.hasSecret
      ? "ready"
      : "missing-key";
  const tuning = [
    props.preference?.temperature !== null && props.preference?.temperature !== undefined ? `温度 ${props.preference.temperature}` : "",
    props.preference?.maxOutputTokens !== null && props.preference?.maxOutputTokens !== undefined ? `最大 ${props.preference.maxOutputTokens} tokens` : "",
  ].filter(Boolean);
  const differences = props.taskKey && props.preference
    ? describeTaskPreferenceDifferences(props.preference, props.taskKey)
    : [];
  const estimate = props.taskKey
    ? estimateNextRunCost(usage.data?.byTask, props.taskKey, props.profile)
    : null;
  const runMultiplier = Math.max(1, Math.floor(props.runMultiplier ?? 1));
  const projectedMicros = estimate?.status === "READY"
    ? estimate.estimatedMicros * runMultiplier
    : null;
  const today = usage.data?.daily.find((row) => (
    row.date === localDateKey()
    && row.currency === budget.data?.currency
  ))?.estimatedCostMicros ?? 0;
  const project = usage.data?.total.find((row) => row.currency === budget.data?.currency)?.estimatedCostMicros ?? 0;
  const dailyProjection = budget.data?.dailyLimitMicros && projectedMicros !== null
    ? budgetWarning("每日", today, projectedMicros, budget.data.dailyLimitMicros)
    : null;
  const projectProjection = budget.data?.projectLimitMicros && projectedMicros !== null
    ? budgetWarning("项目", project, projectedMicros, budget.data.projectLimitMicros)
    : null;
  return <div className="ai-model-note" data-state={modelState}>
    <Cpu size={14} />
    <span>
      <small>{props.taskLabel}模型{tuning.length ? ` · ${tuning.join(" · ")}` : ""}</small>
      <strong>{props.profile ? `${props.profile.name} · ${props.profile.modelId}` : "未配置可用聊天模型"}</strong>
    </span>
    <a href="/settings#ai-task-models">调整</a>
    {props.taskKey ? <div className="ai-model-note-preflight">
      <span>{usage.isPending ? "正在读取历史费用…" : estimate ? nextRunCostLabel(estimate, usage.data?.days, runMultiplier) : "预估样本不足"}</span>
      {props.preference?.prompt.context.inputTokenBudget ? <span>输入预算 {props.preference.prompt.context.inputTokenBudget.toLocaleString()} tokens</span> : null}
      <span data-custom={differences.length > 0 || undefined}>{differences.length ? `配置差异：${differences.join("、")}` : "配置差异：使用推荐值"}</span>
      {dailyProjection ? <span data-warning>{dailyProjection}</span> : null}
      {projectProjection ? <span data-warning>{projectProjection}</span> : null}
    </div> : null}
  </div>;
}

function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function budgetWarning(
  scope: "每日" | "项目",
  spentMicros: number,
  projectedMicros: number,
  limitMicros: number,
) {
  const projectedTotal = spentMicros + projectedMicros;
  if (projectedTotal < limitMicros * 0.8) return null;
  const percent = Math.round((projectedTotal / limitMicros) * 100);
  return projectedTotal >= limitMicros
    ? `本次后预计超过${scope}预算（${percent}%）`
    : `本次后预计接近${scope}预算（${percent}%）`;
}
