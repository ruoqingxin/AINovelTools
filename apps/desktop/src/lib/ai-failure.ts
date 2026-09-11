export type AiFailureKind =
  | "AUTH"
  | "CANCELLED"
  | "CONTENT_POLICY"
  | "CONTEXT_LIMIT"
  | "INVALID_RESPONSE"
  | "NETWORK"
  | "OUTPUT_TRUNCATED"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "UNKNOWN";

export type AiFailureClassification = {
  kind: AiFailureKind;
  label: string;
  hint: string;
};

const classifications: Array<{
  kind: AiFailureKind;
  label: string;
  hint: string;
  patterns: string[];
}> = [
  {
    kind: "CANCELLED",
    label: "任务已取消",
    hint: "需要继续时可重新提交当前任务。",
    patterns: ["cancel", "取消"],
  },
  {
    kind: "TIMEOUT",
    label: "请求超时",
    hint: "可直接重试；连续超时时可换更快模型或提高模型超时时间。",
    patterns: ["timeout", "timed out", "超时"],
  },
  {
    kind: "RATE_LIMIT",
    label: "服务限流",
    hint: "稍后重试，或为该任务配置备用模型。",
    patterns: ["429", "rate limit", "too many requests", "限流", "请求过于频繁"],
  },
  {
    kind: "AUTH",
    label: "密钥或权限不可用",
    hint: "重试前请先在“模型 API”中检查密钥、地址和模型权限。",
    patterns: ["401", "403", "unauthorized", "forbidden", "invalid api key", "api key", "鉴权", "密钥", "权限"],
  },
  {
    kind: "OUTPUT_TRUNCATED",
    label: "生成内容不完整",
    hint: "已保留的部分内容仍在待定区；可提高最大输出后重试，或继续补写后再确认。",
    patterns: ["达到最大输出", "输出长度", "结束前中断", "返回不完整", "结束标记", "停在半句"],
  },
  {
    kind: "CONTEXT_LIMIT",
    label: "上下文超出限制",
    hint: "重试前可降低输入预算或最大输出，也可以关闭部分上下文来源。",
    patterns: ["context length", "context window", "too many tokens", "token limit", "maximum context", "上下文", "长度限制", "超过最大"],
  },
  {
    kind: "CONTENT_POLICY",
    label: "内容安全拦截",
    hint: "调整敏感表达后重试；不要只重复提交相同内容。",
    patterns: ["content policy", "safety", "moderation", "内容安全", "审核拦截", "敏感"],
  },
  {
    kind: "INVALID_RESPONSE",
    label: "返回内容无法解析",
    hint: "可直接重试；连续失败时可适当降低温度或更换模型。",
    patterns: ["json", "parse", "deserialize", "invalid response", "解析", "格式错误"],
  },
  {
    kind: "NETWORK",
    label: "网络连接失败",
    hint: "检查网络或模型服务地址后重试。",
    patterns: ["network", "connection", "connect", "dns", "socket", "网络", "连接失败"],
  },
];

export function classifyAiFailure(message: string | null | undefined): AiFailureClassification {
  const normalized = message?.trim().toLocaleLowerCase() ?? "";
  const matched = classifications.find((classification) => (
    classification.patterns.some((pattern) => normalized.includes(pattern))
  ));
  if (matched) return { kind: matched.kind, label: matched.label, hint: matched.hint };
  return {
    kind: "UNKNOWN",
    label: "执行失败",
    hint: "可直接重试；连续失败时请查看任务日志并检查模型配置。",
  };
}
