import { ClipboardCheck, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { todoHref, todoLabels, useAuthorTodos } from "../lib/author-todos-query";
import { errorMessage, type AuthorTodoKind } from "../lib/tauri-client";
import "./activity-workspace.css";

export function ReviewCenterView() {
  const queue = useAuthorTodos();
  const [kind, setKind] = useState<AuthorTodoKind | "ALL">("ALL");
  const legacy = new URLSearchParams(window.location.search);
  const legacyTab = legacy.get("tab");
  const legacyChapter = legacy.get("chapterId");
  const legacyParams = new URLSearchParams({
    returnTo: "/review",
    ...(legacyTab === "facts" ? { tab: "extraction", knowledge: "facts" }
      : { assistant: "review", purpose: legacyTab === "admission" ? "admission" : "manuscript" }),
  });
  if (legacyChapter) legacyParams.set("referenceChapter", legacyChapter);
  const items = (queue.data?.items ?? []).filter((item) => kind === "ALL" || item.kind === kind);

  return <section className="author-todos activity-workspace">
    <div className="workspace-heading workspace-heading-with-action">
      <div><h1>待办</h1>{queue.isSuccess ? <span className="activity-meta">{queue.data.pendingCount} 项待处理</span> : null}</div>
      <button type="button" className="icon-command" aria-label="刷新待办" title="刷新待办"
        disabled={queue.isFetching} onClick={() => void queue.refetch()}><RefreshCw size={16} /></button>
    </div>
    {legacyTab ? <div className="activity-legacy-entry">
      <a href={`/writing?${legacyParams}${legacyChapter ? `#${encodeURIComponent(legacyChapter)}` : ""}`}>
        {legacyTab === "facts" ? "打开本章事实审核" : legacyTab === "admission" ? "打开生成前检查" : "打开正文检查"}
      </a>
    </div> : null}
    <div className="activity-toolbar">
      <select aria-label="待办类型" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
        <option value="ALL">全部待办</option>
        {Object.entries(todoLabels).map(([value, label]) => <option key={value} value={value}>{label.title}</option>)}
      </select>
    </div>
    {queue.isPending ? <p className="plan-empty" role="status">正在加载待办…</p>
      : queue.isError ? <p className="project-error" role="alert">待办加载失败：{errorMessage(queue.error)}</p>
      : items.length ? <div className="todo-list" aria-label="待处理事项">
        {items.map((item) => <article className="todo-row" key={`${item.kind}-${item.targetId}`} data-risk={item.highRisk || undefined}>
          <div className="todo-target"><strong>{item.targetTitle}</strong><span>{todoLabels[item.kind].title} · {item.count} 项</span></div>
          <div className="todo-state">{item.highRisk ? <span className="todo-risk"><ShieldAlert size={14} />冲突阻断定稿</span> : null}
            <span>{todoLabels[item.kind].status}</span></div>
          <a className="secondary-action" href={todoHref(item, queue.data.projectId)}>{todoLabels[item.kind].action}</a>
        </article>)}
      </div> : <div className="activity-empty"><ClipboardCheck size={26} /><p>{kind === "ALL" ? "暂无待处理事项" : "此类暂无待办"}</p></div>}
  </section>;
}
