import { ArrowLeft, ArrowUpRight, MessageSquareText, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { parseDiscussionSource, planningTargetHref, useDiscussionSource } from "../lib/discussion-source";
import { sourceReturnTo } from "../lib/manuscript-source";
import { errorMessage } from "../lib/tauri-client";
import "./discussion-source.css";

export function DiscussionSourceView({ search }: { search: string }) {
  const request = useMemo(() => parseDiscussionSource(search) ?? { candidateId: "" }, [search]);
  const { project, source } = useDiscussionSource(request);
  const returnTo = sourceReturnTo(new URLSearchParams(search).get("returnTo"));
  const data = source.data;
  const failed = project.isError || source.isError;
  return <section className="discussion-source-view">
    <header className="discussion-source-heading"><div><h1>{data?.session.title ?? "讨论来源"}</h1>
      {data ? <p>原始讨论 · {data.message.role === "USER" ? "作者" : "AI 协作者"}</p> : null}</div>
      <div className="discussion-source-actions">
        {returnTo ? <a className="secondary-action" href={returnTo}><ArrowLeft size={14} />返回来源</a>
          : <button type="button" className="secondary-action" onClick={() => window.history.back()}><ArrowLeft size={14} />返回</button>}
        {data && !failed ? <a className="secondary-action" href={`/discussion#${encodeURIComponent(data.session.id)}`}><MessageSquareText size={14} />进入讨论</a> : null}
      </div>
    </header>
    {failed ? <div className="project-error" role="alert"><p>无法定位讨论来源：{errorMessage(project.error ?? source.error)}。未打开其他讨论。</p>
      <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : source.refetch())}><RefreshCw size={14} />重试定位</button></div>
      : !project.isPending && !project.data ? <p className="project-error" role="alert">未打开来源项目。</p>
      : source.isPending ? <p role="status">正在校验讨论来源…</p> : null}
    {data && !failed ? <>
      <div className="discussion-source-metadata"><span>候选 <code>{data.candidate.id}</code></span><span>消息 <code>{data.message.id}</code></span></div>
      <section className="discussion-source-text" aria-label="原始讨论消息"><h2>原始消息</h2><p>{data.message.content}</p></section>
      <section className="discussion-source-text" aria-label="候选快照"><h2>候选内容</h2><p>{data.candidate.content}</p></section>
      {data.candidate.kind === "PLANNING" || data.candidate.kind === "SETTING" ? <footer className="discussion-source-transfer">
        <span>{data.candidate.status === "PROMOTED" ? "曾送入规划待定区" : data.candidate.status === "DISMISSED" ? "已忽略" : "尚未送入规划"}{data.candidate.targetSectionId ? ` · ${data.candidate.targetSectionId}` : ""}</span>
        {data.planningTargetAvailable && data.candidate.targetSectionId ? <a className="secondary-action"
          href={planningTargetHref(data.candidate.targetSectionId, data.session.projectId, data.planningTargetKind)}><ArrowUpRight size={14} />打开规划待定区</a>
          : data.candidate.status === "PROMOTED" ? <span role="status">目标规划已不可用</span> : null}
      </footer> : null}
    </> : null}
  </section>;
}
