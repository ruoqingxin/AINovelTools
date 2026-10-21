import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, getCurrentProject, listAuthorSettings } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { entityHref } from "../lib/entity-navigation";
import "./library-workspace.css";
import { SearchField } from "./search-field";

export function AuthorSettingsView() {
  const settings = useQuery({ queryKey: ["author-settings"], queryFn: listAuthorSettings });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState("ALL");
  const [page, setPage] = useState(1);
  const filtered = (settings.data ?? []).filter((setting) =>
    (visibility === "ALL" || setting.visibility === visibility)
    && `${setting.entityName} ${setting.content}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = settings.data?.find((setting) => setting.id === selectedId);
  return <section className="story-bible-view author-settings-view library-workspace">
    <div className="workspace-heading"><h1>作者设定</h1></div>
    <KnowledgeSectionNav />
    <div className="library-toolbar">
      <SearchField label="搜索作者设定" placeholder="搜索名称或设定"
        value={search} onChange={(value) => { setSearch(value); setPage(1); }} />
      <select aria-label="设定公开状态" value={visibility} onChange={(event) => { setVisibility(event.target.value); setPage(1); }}>
        <option value="ALL">全部设定</option><option value="AUTHOR_ONLY">作者保留／尚未揭示</option><option value="PUBLIC">可向读者揭示</option>
      </select><span>{filtered.length} 条</span>
    </div>
    {settings.isPending ? <p className="plan-empty">正在加载设定…</p> : null}
    {settings.isError ? <p className="project-error" role="alert">{errorMessage(settings.error)}<button type="button" onClick={() => void settings.refetch()}>重试</button></p> : null}
    {project.isError ? <p className="project-error" role="alert">{errorMessage(project.error)}<button type="button" onClick={() => void project.refetch()}>重试作品信息</button></p> : null}
    {settings.isSuccess && !filtered.length ? <div className="library-list-empty">
      <p className="plan-empty">{settings.data.length ? "没有符合条件的作者设定。" : "暂无作者设定"}</p>
      {search || visibility !== "ALL" ? <button type="button" className="secondary-action" onClick={() => {
        setSearch(""); setVisibility("ALL"); setPage(1);
      }}>重置筛选</button> : null}</div> : null}
    <div className="library-layout"><div className="library-list" aria-label="作者设定列表">
      {filtered.slice(0, page * 100).map((setting) => <button type="button" key={setting.id} className="library-item"
        data-selected={selectedId === setting.id} onClick={() => setSelectedId(setting.id)}>
        <strong>{setting.entityName}</strong><span>{setting.content.slice(0, 70)}</span>
        <small>{setting.visibility === "AUTHOR_ONLY" ? "尚未揭示" : "可揭示"}</small>
      </button>)}
    </div><div className="library-detail">
      {selected ? <><h2>{selected.entityName}</h2><p className="library-meta">作者确认 · {selected.visibility === "AUTHOR_ONLY" ? "尚未揭示" : "可向读者揭示"}</p>
        <p className="library-content">{selected.content}</p>
        <div className="library-actions"><a className="secondary-action" href={`/discussion#${encodeURIComponent(selected.sessionId)}`}>来源讨论</a>
          {project.data ? <a className="secondary-action" href={entityHref(selected.entityId, project.data.projectId, "/knowledge/settings")}>关联人物或世界资料</a> : null}
        </div><details className="library-advanced"><summary>来源信息</summary><p>来源修订 <code>{selected.entityRevisionId}</code></p><p>整理结果 <code>{selected.sourceProposalId}</code></p></details>
      </> : <div className="library-empty"><p>{settings.isPending ? "正在加载设定…" : settings.isError ? "设定暂不可用"
        : !settings.data?.length ? "尚未添加作者设定" : "选择一条作者设定"}</p></div>}
    </div></div>
    {filtered.length > page * 100 ? <button type="button" className="secondary-action" onClick={() => setPage((current) => current + 1)}>更多设定</button> : null}
  </section>;
}
