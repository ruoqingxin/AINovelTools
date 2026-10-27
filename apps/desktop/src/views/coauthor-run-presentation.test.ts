import { describe, expect, it } from "vitest";
import { coauthorStepLabel, coauthorToolLabel, retrievalDisplay, retrievalHeader, splitLegacyRetrieval } from "./coauthor-run-presentation";

const receipt = `${retrievalHeader}\n- 关键词 "契约"（项目资料，offset=0）：实际返回 4 条，仍有后续页；关键词索引待更新 2 项，不能据此声称查全。\n`
  + "- 语义 \"契约\"（项目资料，offset=0）：未调用向量服务（未授权或无可用索引），不是 0 命中。\n"
  + "- 关键词 \"砂\"（项目资料，offset=0）：未形成有效查询，不能记为 0 命中。\n"
  + "最近一次语义索引快照：已索引分块 5，语义索引待更新 2；与查证索引独立，不合并计数。\n"
  + "未检索到不等于不存在；未形成有效查询、未授权或索引不完整均不能证明查全。";

describe("Chinese coauthor run presentation", () => {
  it("describes runtime actions without exposing internal names or raw candidate text", () => {
    expect(coauthorStepLabel({ kind: "initial_decisions" })).toContain("讨论的决定");
    expect(coauthorStepLabel({ kind: "context_assembly" })).toContain("整理");
    expect(coauthorStepLabel({ kind: "model_request", round: 2, inputChars: 400 })).toBe("向模型发送第 2 次请求 · 输入估算 400 字符");
    expect(coauthorStepLabel({ kind: "reply_candidate", content: "不能公开的候选" })).not.toContain("不能公开");
    expect(coauthorStepLabel({ kind: "future_event", message: "internal English secret" })).toBe("其他运行记录");
    expect(coauthorStepLabel(null)).toBe("其他运行记录");
    expect(coauthorToolLabel("unknown_tool")).toBe("执行辅助操作");
  });

  it("does not report a failed tool as successful", () => {
    expect(coauthorStepLabel({ kind: "tool", name: "search_sources", result: { hits: [] } })).toBe("按关键词检索资料 · 已返回结果，是否有效需核对");
    for (const result of [{ executed: false }, { error: "失败" }]) {
      expect(coauthorStepLabel({ kind: "tool", name: "read_source", result })).toBe("读取资料原文 · 未成功执行");
    }
  });

  it("separates only exact old generated trailing receipts and preserves the original reply", () => {
    const content = `原文保留。\n\n第二段。\n\n${receipt}`;
    expect(splitLegacyRetrieval(content)).toEqual({ reply: "原文保留。\n\n第二段。", receipt });
    expect(retrievalDisplay({ output: content, audit: [] })).toBe(receipt);
  });

  it("does not swallow quoted, malformed or partial receipt-like prose", () => {
    for (const content of [receipt, `引用：\n\n${receipt}\n还有解释。`, `正文\n\n${receipt.replace("实际返回 4 条", "这是一段普通论述")}`,
      `正文\n\n${receipt.replace('关键词 "契约"', '关键词 "坏\\q"')}`, `正文\n\n${retrievalHeader}\n只是一个标题。`]) {
      expect(splitLegacyRetrieval(content)).toEqual({ reply: content, receipt: null });
    }
  });

  it("prefers separate audit receipts over legacy display and never substitutes raw tool results", () => {
    expect(retrievalDisplay({ output: "正常回复", audit: [{ kind: "retrieval_summary", displayText: receipt, receipts: [] }] })).toBe(receipt);
    expect(retrievalDisplay({ output: "正常回复", audit: [{ kind: "tool", result: { secret: "候选" } }] })).toBeNull();
  });
});
