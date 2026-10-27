import type { CoauthorRun } from "../lib/tauri-client";
import { replyFeedback } from "./coauthor-reply-diagnostics";

export function CoauthorRunFeedback({ run }: { run: CoauthorRun }) {
  const feedback = replyFeedback(run);
  return <div className="coauthor-feedback-body" role="region" aria-label="本轮问题与局限">
    <p>{feedback.review}</p>
    {feedback.problems.length > 0 && <ul>{feedback.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
    {feedback.priorIssues.length > 0 && <p>复核曾提示：{feedback.priorIssues.join("、")}。这些意见针对此前未展示的候选，不等于最终回复已解决或仍有同样问题。</p>}
    {(feedback.rejected > 0 || feedback.toolErrors > 0) && <p>过程中有 {feedback.rejected} 次交付被拒、{feedback.toolErrors} 次工具报错；过程记录不等于最终回答的问题诊断。</p>}
    {feedback.coverage.length > 0 && <details><summary>本轮检索范围记录</summary>
      <ul>{feedback.coverage.map((coverage) => <li key={coverage}>{coverage}</li>)}</ul>
    </details>}
    <p>仍需留意：可能扩大条件或否定范围、把新推论当作原有规则，或遗漏前文事件。程序不能可靠识别所有这类错误。</p>
  </div>;
}
