import { errorMessage, type AiAction, type AiConsistencyReport, type ConsistencyReviewFreshness, type WritingReviewPolicy } from "../lib/tauri-client";
import { classifyAiFailure } from "../lib/ai-failure";

export const actionLabels: Record<AiAction, string> = {
  DRAFT: "AI 创作整章",
  CONTINUE: "续写",
  REWRITE: "重写选区",
  POLISH: "润色选区",
  SUMMARIZE: "章节摘要",
  CONSISTENCY_CHECK: "一致性检查",
};
export function consistencyAdmission(
  report: AiConsistencyReport | null,
  freshness: ConsistencyReviewFreshness | null,
  policy: WritingReviewPolicy,
) {
  if (!report) {
    return {
      state: "blocked",
      text: "当前作品采用严格准入，生成正文前必须完成一次与当前输入一致的创作准入检查。",
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
      text: `最近一次审核发现 ${blockerCount} 个阻断问题，整章创作已暂停。请先处理问题并关闭本次审核。`,
    };
  }
  if (report.verdict === "NEEDS_INPUT") {
    return {
      state: "needs_input",
      text: "审核发现部分正式依据未记录或无法确认。未知项可以保留，正文生成不会被阻断；请避免把推测写成既成事实。",
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

export function textContent(text: string) {
  return text.split(/\r?\n/).map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : undefined,
  }));
}

export function documentHasText(documentJson: string) {
  if (!documentJson.trim()) return false;
  try {
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(visit);
      const record = value as Record<string, unknown>;
      return typeof record.text === "string" && Boolean(record.text.trim())
        || Object.values(record).some(visit);
    };
    return visit(JSON.parse(documentJson) as unknown);
  } catch {
    return true;
  }
}

export function aiFailureMessage(cause: unknown) {
  const detail = errorMessage(cause).trim();
  const failure = classifyAiFailure(detail);
  if (failure.kind === "UNKNOWN") return detail || failure.label;
  if (detail.startsWith(`${failure.label}：`)) return `${detail} ${failure.hint}`;
  return `${failure.label}：${detail} ${failure.hint}`;
}

export function buildLineDiff(left: string, right: string) {
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

export type ProposalAnchor = {
  from: number;
  to: number;
  selection: string;
};

