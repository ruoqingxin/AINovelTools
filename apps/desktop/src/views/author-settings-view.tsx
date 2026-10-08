import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { errorMessage, listAuthorSettings } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";

export function AuthorSettingsView() {
  const settings = useQuery({ queryKey: ["author-settings"], queryFn: listAuthorSettings });
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState("ALL");
  const [page, setPage] = useState(1);
  const filtered = (settings.data ?? []).filter((setting) =>
    (visibility === "ALL" || setting.visibility === visibility)
    && `${setting.entityName} ${setting.content}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="story-bible-view author-settings-view">
    <div className="workspace-heading"><p className="eyebrow">知识资料</p><h1>作者设定</h1></div>
    <KnowledgeSectionNav />
    <div className="story-bible-toolbar">
      <label className="search-field"><Search size={15} /><input aria-label="搜索作者设定" placeholder="搜索名称或设定"
        value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
      <select aria-label="设定公开状态" value={visibility} onChange={(event) => { setVisibility(event.target.value); setPage(1); }}>
        <option value="ALL">全部设定</option><option value="AUTHOR_ONLY">作者保留／尚未揭示</option><option value="PUBLIC">可向读者揭示</option>
      </select><span>{filtered.length} 条</span>
    </div>
    {settings.isPending ? <p className="plan-empty">正在加载设定…</p> : null}
    {settings.isError ? <p className="project-error" role="alert">{errorMessage(settings.error)}</p> : null}
    {settings.isSuccess && !filtered.length ? <p className="plan-empty">暂无符合条件的作者设定。</p> : null}
    <div className="author-setting-list">
      {filtered.slice(0, page * 100).map((setting) => <article key={setting.id} className="author-setting-row">
        <header><strong>{setting.entityName}</strong>
          <span>{setting.visibility === "AUTHOR_ONLY" ? "尚未揭示" : "可揭示"}</span></header>
        <p>{setting.content}</p>
        <footer><span>作者确认</span><a href={`/discussion#${setting.sessionId}`}>来源讨论</a><a href="/knowledge">关联实体</a></footer>
      </article>)}
    </div>
    {filtered.length > page * 100 ? <button type="button" className="secondary-action" onClick={() => setPage((current) => current + 1)}>更多设定</button> : null}
  </section>;
}
