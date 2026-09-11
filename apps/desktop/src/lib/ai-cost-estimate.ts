import type { AiUsageTaskSummary, ModelProfile } from "./tauri-client";

export type NextRunCostEstimate =
  | { status: "MISSING_PROFILE" }
  | { status: "MISSING_PRICE" }
  | { status: "INSUFFICIENT_SAMPLES" }
  | {
    status: "READY";
    estimatedMicros: number;
    currency: string;
    runCount: number;
  };

export function formatCost(micros: number | null, currency: string) {
  if (micros === null) return "未设置单价";
  const amount = micros / 1_000_000;
  const formatted = amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
  return `${currency} ${formatted}`;
}

function averageTaskTokens(rows: AiUsageTaskSummary[] | undefined, taskKey: string) {
  const matches = rows?.filter((row) => row.taskKey === taskKey) ?? [];
  const runCount = matches.reduce((total, row) => total + row.runCount, 0);
  if (!runCount) return null;
  return {
    runCount,
    inputTokens: matches.reduce((total, row) => total + row.inputTokens, 0) / runCount,
    outputTokens: matches.reduce((total, row) => total + row.outputTokens, 0) / runCount,
  };
}

export function estimateNextRunCost(
  rows: AiUsageTaskSummary[] | undefined,
  taskKey: string,
  profile: ModelProfile | undefined,
): NextRunCostEstimate {
  if (!profile) return { status: "MISSING_PROFILE" };
  const inputPrice = profile.inputPriceMicrosPerMillion;
  const outputPrice = profile.outputPriceMicrosPerMillion;
  if (
    !Number.isFinite(inputPrice)
    || !Number.isFinite(outputPrice)
    || (inputPrice <= 0 && outputPrice <= 0)
  ) {
    return { status: "MISSING_PRICE" };
  }
  const average = averageTaskTokens(rows, taskKey);
  if (!average) return { status: "INSUFFICIENT_SAMPLES" };
  return {
    status: "READY",
    estimatedMicros: Math.round(
      average.inputTokens * inputPrice / 1_000_000
      + average.outputTokens * outputPrice / 1_000_000,
    ),
    currency: profile.priceCurrency || "CNY",
    runCount: average.runCount,
  };
}

export function nextRunCostLabel(
  estimate: NextRunCostEstimate,
  days = 30,
  runMultiplier = 1,
) {
  if (estimate.status === "MISSING_PROFILE") return "选择模型后预估费用";
  if (estimate.status === "MISSING_PRICE") return "未设置模型单价";
  if (estimate.status === "INSUFFICIENT_SAMPLES") return "预估样本不足";
  const projectedMicros = estimate.estimatedMicros * Math.max(1, runMultiplier);
  const prefix = runMultiplier > 1 ? `预估本批 ${runMultiplier} 次约` : "预估下一次约";
  return `${prefix} ${formatCost(projectedMicros, estimate.currency)} · 基于近 ${days} 天 ${estimate.runCount} 次记录`;
}
