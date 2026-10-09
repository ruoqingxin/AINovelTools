import { ArrowLeft, BookOpenText, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { errorMessage } from "../lib/tauri-client";
import { parseManuscriptSource, sourceReturnTo, useManuscriptSource } from "../lib/manuscript-source";
import { ManuscriptReader } from "./manuscript-reader";
import { formatSavedAt } from "./project-workspace-utils";
import "./manuscript-source-view.css";

export function ManuscriptSourceView({ search }: { search: string }) {
  const request = useMemo(() => parseManuscriptSource(search) ?? {}, [search]);
  const { project, source } = useManuscriptSource(request);
  const returnTo = sourceReturnTo(new URLSearchParams(search).get("returnTo"));
  const data = source.data;
  return <section className="manuscript-source-view">
    <header className="manuscript-source-heading">
      <div>
        <h1>{data?.chapterTitle ?? "正文来源"}</h1>
        {data ? <p>{data.isCurrentRevision ? "当前修订" : "历史修订"} · {formatSavedAt(data.revision.createdAt)}
          {data.chapterArchived ? " · 章节已归档" : ""}</p> : null}
      </div>
      <div className="manuscript-source-actions">
        {returnTo ? <a className="secondary-action" href={returnTo}><ArrowLeft size={14} />返回来源</a>
          : <button type="button" className="secondary-action" onClick={() => window.history.back()}><ArrowLeft size={14} />返回</button>}
        {data && !data.chapterArchived ? <a className="primary-action" href={`/writing#${encodeURIComponent(data.revision.chapterId)}`}>
          <BookOpenText size={14} />进入本章</a> : null}
      </div>
    </header>
    {project.isError || source.isError ? <div role="alert" className="project-error">
      <p>无法定位正文来源：{errorMessage(project.error ?? source.error)}。未切换到其他修订。</p>
      <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : source.refetch())}>
        <RefreshCw size={14} />重试定位</button>
    </div> : !project.isPending && !project.data ? <p role="alert" className="project-error">未打开来源项目。</p>
      : source.isPending ? <p className="plan-empty" role="status">正在校验正文来源…</p> : null}
    {data && !source.isError ? <>
      <div className="manuscript-source-metadata"><span>修订 <code>{data.revision.id}</code></span>
        {data.blockId ? <span>段落 <code>{data.blockId}</code></span> : null}
      </div>
      {data.quote ? <blockquote className="manuscript-source-quote" aria-label="绑定的原文证据">{data.quote}</blockquote> : null}
      <ManuscriptReader documentJson={data.revision.documentJson} blockId={data.blockId ?? undefined} ariaLabel="来源正文" />
    </> : null}
  </section>;
}
