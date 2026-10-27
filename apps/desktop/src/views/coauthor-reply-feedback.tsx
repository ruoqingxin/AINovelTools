import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, MessageSquareText, RefreshCw } from "lucide-react";
import { useState } from "react";
import { errorMessage, getCoauthorRun, type CoauthorRun, type CoauthorScope } from "../lib/tauri-client";
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

export function CoauthorReplyFeedback({ scope, runId, status, disabled, onReview }: {
  scope: CoauthorScope; runId?: string; status?: string; disabled: boolean; onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["coauthor-run", scope.projectId, scope.sessionId, runId],
    queryFn: () => getCoauthorRun({ scope, id: runId! }),
    enabled: open && Boolean(runId), retry: false,
  });
  const currentStatus = query.isSuccess && !query.isFetching ? query.data.status : status;
  return <footer className="coauthor-reply-feedback">
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><AlertTriangle size={14} aria-hidden="true" />{currentStatus === "COMPLETED"
        ? "已生成 · 内容待核对" : currentStatus ? "本轮未完成 · 查看问题" : "内容与运行状态待核实"}</summary>
      {open && <>
        {query.isPending && runId && <p role="status">正在读取本轮问题记录…</p>}
        {query.error && <p role="alert">问题记录无法读取：{errorMessage(query.error)}。不能据此认定回答没有问题。
          <button type="button" className="icon-command" title="重新读取本轮问题" aria-label="重新读取本轮问题"
            disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} /></button>
        </p>}
        {query.isFetching && query.data && <p role="status">正在核实运行状态，以下为上次记录。</p>}
        {query.data && <CoauthorRunFeedback run={query.data} />}
        {!runId && <p>此回复没有关联的运行记录，无法核实是否复核过；内容仍需对照原文确认。</p>}
      </>}
    </details>
    <button type="button" disabled={disabled} title={disabled ? "请先等待当前操作结束，或停止生成" : "将这条回复带入输入框，尚不发送"}
      onClick={onReview}><MessageSquareText size={14} />核对这条回复</button>
  </footer>;
}
