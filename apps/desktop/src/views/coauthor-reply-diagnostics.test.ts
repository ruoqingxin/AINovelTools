import { describe, expect, it } from "vitest";
import type { CoauthorRun } from "../lib/tauri-client";
import { replyFeedback, replyReviewRequest } from "./coauthor-reply-diagnostics";

function run(audit: unknown[], status = "COMPLETED"): CoauthorRun {
  return { id: "run", sessionId: "s1", userMessageId: "u", documentVersion: 1, output: "", audit, status };
}

describe("coauthor reply diagnostics", () => {
  it("does not equate completion, skipped review or legacy records with correct content", () => {
    expect(replyFeedback(run([])).review).toContain("没有可核实");
    expect(replyFeedback(run([{ kind: "content_review_skipped" }])).review).toContain("未追加");
    expect(replyFeedback(run([{ kind: "reply_delivery", semanticVerified: false }])).review).not.toContain("通过");
  });

  it("keeps PASS explicitly fallible", () => {
    const result = replyFeedback(run([{ kind: "content_review", result: { decision: "PASS", issues: [] } }]));
    expect(result.review).toContain("同一模型");
    expect(result.review).toContain("不代表内容正确");
    expect(result.problems).toEqual([]);
  });

  it("does not let an earlier PASS conceal failed later review", () => {
    const result = replyFeedback(run([
      { kind: "content_review", result: { decision: "PASS" } }, { kind: "content_review_error", stage: "REVIEW_ARGUMENTS" },
    ], "FAILED"));
    expect(result.review).toContain("未完成");
    expect(result.problems[0]).toContain("未通过校验");
  });

  it("uses the last review, and labels earlier findings without exposing withheld candidate text", () => {
    const result = replyFeedback(run([
      { kind: "reply_candidate", content: "不应展示的候选正文" },
      { kind: "content_review", result: { decision: "REVISE", issues: [
        { kind: "EXPLICIT_CONSTRAINT", candidateQuote: "不应展示的候选正文", reason: "复述未展示候选" },
      ] } },
      { kind: "content_review", result: { decision: "PASS", issues: [] } },
    ]));
    expect(result.priorIssues).toEqual(["违反明确约束"]);
    expect(result.review).toContain("不代表内容正确");
    expect(JSON.stringify(result)).not.toContain("不应展示");
    expect(JSON.stringify(result)).not.toContain("复述未展示");
  });

  it("distinguishes missing context from confirmed conflict", () => {
    expect(replyFeedback(run([{ kind: "content_review", result: { decision: "NEED_CONTEXT" } }], "FAILED")).review)
      .toContain("依据不足");
  });

  it("preserves actual failure and incomplete or uncertain coverage without claiming all checked", () => {
    const result = replyFeedback(run([
      { kind: "error", message: "连接已断开" }, { kind: "error", message: "连接已断开" },
      { kind: "check_summary", check: { title: "旧章", complete: false, uncertain: 2 } },
      { kind: "budget_limit" }, { kind: "round_limit" }, { kind: "check_summary_error" },
    ], "LIMIT_REACHED"));
    expect(result.problems.filter((problem) => problem === "连接已断开")).toHaveLength(1);
    expect(result.problems.join("\n")).toContain("尚未完成");
    expect(result.problems.join("\n")).toContain("2 项待核对");
    expect(result.problems.join("\n")).toContain("上下文预算");
    expect(result.problems.join("\n")).toContain("请求次数上限");
    expect(result.problems.join("\n")).toContain("台账读取失败");
  });

  it("does not confuse recovered attempts with final semantic errors", () => {
    const result = replyFeedback(run([
      { kind: "reply_delivery_rejected" }, { kind: "tool", result: { error: "bad request" } },
      { kind: "tool", result: { hits: [] } }, { kind: "reply_delivery" },
    ]));
    expect(result.rejected).toBe(1);
    expect(result.toolErrors).toBe(1);
    expect(result.problems).toEqual([]);
  });

  it("preserves actual retrieval coverage without turning failed or partial searches into an absence claim", () => {
    const result = replyFeedback(run([
      { kind: "initial_search", result: { coverage: "关键词候选，不代表全书。" } },
      { kind: "initial_semantic_search", result: { coverage: "只覆盖 8/17 块。" } },
      { kind: "tool", name: "search_semantic_sources", result: { error: "向量服务不可用" } },
      { kind: "tool", name: "read_source", result: { content: "不要读取此内容作为范围" } },
    ]));
    expect(result.coverage).toEqual(["关键词候选，不代表全书。", "只覆盖 8/17 块。", "该次检索失败：向量服务不可用"]);
    expect(result.problems).toEqual([]);
  });

  it("tolerates unstructured historical audit entries", () => {
    expect(() => replyFeedback(run([null, [], "text", 1, { kind: "content_review", result: null }]))).not.toThrow();
  });

  it("targets the exact full reply as quoted data, without requesting an extra reviewer or edits", () => {
    const request = replyReviewRequest({ id: "old", content: '第一段。\n"第二段😀"', contextVersion: "coauthor:exact" });
    expect(request).toContain('"messageId": "old"');
    expect(request).toContain('"contextVersion": "coauthor:exact"');
    expect(request).toContain(JSON.stringify('第一段。\n"第二段😀"'));
    expect(request).toContain("本轮只讨论，不修改工作稿");
    expect(request).not.toContain("严格复核");
  });
});
