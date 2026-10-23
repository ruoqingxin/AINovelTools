import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ArrowUpRight, MessageSquareText, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  errorMessage, listCoauthorDecisionConsumers, type CoauthorDecision, type CoauthorDecisionConsumer, type CoauthorScope,
} from "../lib/tauri-client";
import { decisionStatuses } from "./coauthor-decision-dependencies";

const states: Record<string, string> = {
  PENDING: "待确认方案", ADOPTED: "已采用项目", NOT_ADOPTED: "本项未采用", DISCARDED: "方案已放弃", REVERSED: "采用已撤销",
};
const kinds = { MANUSCRIPT: "正文", SETTING: "设定", OUTLINE: "大纲" } as const;
type Props = {
  scope: CoauthorScope; decision: CoauthorDecision; onOpenChangeSet: (id: string) => void;
  onDiscussItem: (decision: CoauthorDecision, item: CoauthorDecisionConsumer) => void;
};

export function CoauthorDecisionConsumers(props: Props) {
  return <ConsumerDirectory key={`${props.scope.projectId}:${props.scope.sessionId}:${props.decision.id}:${props.decision.version}`} {...props} />;
}

function ConsumerDirectory({ scope, decision, onOpenChangeSet, onDiscussItem }: Props) {
  const [open, setOpen] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(true);
  const [offset, setOffset] = useState(0);
  const directory = useQuery({
    queryKey: ["coauthor-decision-consumers", scope.projectId, scope.sessionId, decision.id, decision.version, reviewOnly, offset],
    queryFn: () => listCoauthorDecisionConsumers({ scope, decisionId: decision.id, needsReviewOnly: reviewOnly, offset }),
    enabled: open, retry: false,
  });
  const verified = directory.isSuccess && !directory.isFetching;
  return <details className="coauthor-decision-consumers" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>决定关联与影响</summary>
    {open && <section aria-label="决定关联项目">
      <div className="coauthor-change-actions">
        <label><input type="checkbox" checked={reviewOnly} disabled={directory.isFetching}
          onChange={(event) => { setReviewOnly(event.target.checked); setOffset(0); }} />仅需复查</label>
        <button type="button" className="icon-command" title="刷新决定关联" aria-label="刷新决定关联"
          disabled={directory.isFetching} onClick={() => void directory.refetch()}><RefreshCw size={16} /></button>
      </div>
      {directory.isFetching && <p role="status">正在核对决定关联…</p>}
      {directory.error && <p role="alert" className="project-error">决定关联无法核实：{errorMessage(directory.error)}</p>}
      {directory.data && <>
        {!verified && <p role="status">以下为缓存记录，当前关联及复查状态尚未核实。</p>}
        <p>{verified ? "读取时当前决定" : "上次读取决定"} · v{directory.data.decision.version} · {decisionStatuses[directory.data.decision.status]}</p>
        <p className="coauthor-notice">仅含本讨论明确声明的依赖，未自动检查隐含语义关系；旧版依赖需复查，不等于已证实矛盾。</p>
        {directory.data.unknownChangeSets > 0 && <p role="alert" className="coauthor-notice">
          另有 {directory.data.unknownChangeSets} 份有效或待确认方案未记录依赖，无法判断是否相关。
        </p>}
        {!directory.data.entries.length && verified && <p>{reviewOnly ? "没有需要复查的明确依赖项。" : "此页没有明确依赖项。"}</p>}
        {directory.data.entries.map((entry) => <article className="coauthor-source" key={`${entry.changeSetId}:${entry.itemId}`}>
          <strong>{entry.itemTitle}</strong><small>{kinds[entry.kind]} · {states[entry.state]} · 依赖 v{entry.decisionVersion}</small>
          <small>原方案：{entry.changeSetTitle} · v{entry.changeSetVersion}</small>
          <small>方案标识：{entry.changeSetId} · 项目：{entry.itemId}</small>
          {entry.needsReview && <p className="project-error">{verified ? "决定版本已变化，需复查此项。" : "上次读取时标记需复查，当前状态未核实。"}</p>}
          {entry.publishedKey && <><small>当时采用目标：{entry.publishedKey}</small>
            <small>当时采用修订：{entry.publishedRevision}</small>
            <p className="coauthor-notice">这是原采用记录，不代表目标仍处于该修订；正式内容未自动修改。</p></>}
          <div className="coauthor-change-actions">
            <button type="button" disabled={!verified} onClick={() => onOpenChangeSet(entry.changeSetId)}>
              <ArrowUpRight size={14} />{entry.state === "PENDING" || entry.state === "DISCARDED" ? "核对原方案" : "查看采用回执"}
            </button>
            <button type="button" disabled={!verified} onClick={() => { if (directory.data) onDiscussItem(directory.data.decision, entry); }}>
              <MessageSquareText size={14} />带回讨论核对
            </button>
          </div>
        </article>)}
        {(offset > 0 || directory.data.hasMore) && <nav className="coauthor-check-pagination" aria-label="决定关联分页">
          <button type="button" className="icon-command" title="上一页决定关联" aria-label="上一页决定关联"
            disabled={!verified || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 16))}><ArrowLeft size={16} /></button>
          <span>第 {offset / 16 + 1} 页</span>
          <button type="button" className="icon-command" title="下一页决定关联" aria-label="下一页决定关联"
            disabled={!verified || !directory.data.hasMore} onClick={() => setOffset((value) => value + 16)}><ArrowRight size={16} /></button>
        </nav>}
      </>}
    </section>}
  </details>;
}
