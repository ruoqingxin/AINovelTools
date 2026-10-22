import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useState } from "react";
import {
  errorMessage, listCoauthorDecisionHistory,
  type CoauthorDecision, type CoauthorDecisionContext, type CoauthorScope,
} from "../lib/tauri-client";

const statuses: Record<string, string> = { CHOSEN: "已选择", REJECTED: "已否定", OPEN: "待定", WITHDRAWN: "已撤回" };

export function DecisionContext({ context }: { context?: CoauthorDecisionContext | null }) {
  if (!context) return null;
  return <aside className="coauthor-memory-context" aria-label="读取时的决定关联">
    <strong>读取时的决定关联</strong>
    {context.guards.map((guard) => <section key={guard.current.id}>
      <p>{guard.current.topic} · {guard.superseded ? "关联旧选择已被替代" : "关联当前选择"}</p>
      <small>{statuses[guard.current.status] ?? guard.current.status} · v{guard.current.version}</small>
      <p>{guard.current.content}</p>
    </section>)}
    {context.hasMore && <p role="status">尚有决定关联未展开。</p>}
  </aside>;
}

export function CoauthorDecisionHistory({ scope, decision }: { scope: CoauthorScope; decision: CoauthorDecision }) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const beforeVersion = cursors[cursors.length - 1];
  const history = useQuery({
    queryKey: ["coauthor-decision-history", scope.projectId, scope.sessionId, decision.id, decision.version, beforeVersion],
    queryFn: () => listCoauthorDecisionHistory({ scope, id: decision.id, beforeVersion }),
    enabled: open, retry: false,
  });
  return <details className="coauthor-decision-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>决定来源与修订</summary>
    {open && <>
      {history.isPending && <p role="status">正在读取决定修订…</p>}
      {history.error && <p role="alert" className="project-error">决定修订无法核实：{errorMessage(history.error)}</p>}
      {history.data && <>
        {(history.isError || history.isFetching) && <p role="status">以下为上次修订记录，当前状态尚未核实。</p>}
        <small>决定 {history.data.current.decision.id}</small>
        <p>主题别名：{history.data.current.aliases.join("、") || decision.topic}</p>
        {history.data.revisions.map((revision) => <section className="coauthor-decision-revision" key={revision.decision.version}>
          <strong>v{revision.decision.version} · {revision.decision.version === history.data.current.decision.version ? "当前修订" : "已替代（历史）"}</strong>
          <small>{statuses[revision.decision.status] ?? revision.decision.status}</small>
          <p>{revision.decision.content}</p>
          {revision.quote ? <blockquote>{revision.quote}</blockquote> : <small>旧记录未保存独立原话，原始消息仍保留。</small>}
          <small>来源消息 {revision.decision.sourceMessageId}</small>
        </section>)}
        {(cursors.length > 1 || history.data.hasMore) && <nav className="coauthor-check-pagination" aria-label="决定修订分页">
          <button type="button" className="icon-command" aria-label="较新决定修订" title="较新决定修订"
            disabled={cursors.length === 1 || history.isFetching} onClick={() => setCursors((values) => values.slice(0, -1))}><ArrowLeft size={16} /></button>
          <span>第 {cursors.length} 页</span>
          <button type="button" className="icon-command" aria-label="更早决定修订" title="更早决定修订"
            disabled={!history.data.hasMore || history.isFetching || !history.data.revisions.length}
            onClick={() => setCursors((values) => [...values, history.data!.revisions[history.data!.revisions.length - 1].decision.version])}><ArrowRight size={16} /></button>
        </nav>}
      </>}
    </>}
  </details>;
}
