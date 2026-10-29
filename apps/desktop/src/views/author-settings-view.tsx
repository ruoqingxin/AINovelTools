import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, BookOpenText, Eye, MessageSquareText, SearchX } from "lucide-react";
import { errorMessage, getCurrentProject, listAuthorSettings } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { entityHref } from "../lib/entity-navigation";
import "./library-workspace.css";
import { SearchField } from "./search-field";
import { ContentTypeLabel } from "./content-identity";
import { useLibraryNavigation } from "./use-library-navigation";
import { WorkspaceLink } from "./workspace-link";
import { WorkspaceEmptyState } from "./workspace-empty-state";

export function AuthorSettingsView() {
  const settings = useQuery({ queryKey: ["author-settings"], queryFn: listAuthorSettings });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigation = useLibraryNavigation();
  const mobileDetail = !navigation.wide && navigation.detailOpen;
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState("ALL");
  const [page, setPage] = useState(1);
  const filtered = (settings.data ?? []).filter((setting) =>
    (visibility === "ALL" || setting.visibility === visibility)
    && `${setting.entityName} ${setting.content}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = settings.data?.find((setting) => setting.id === selectedId);
  const emptyCollection = navigation.wide && settings.isSuccess && !filtered.length && !selected;
  const filteredEmpty = Boolean(search.trim() || visibility !== "ALL" || settings.data?.length);
  function resetFilters() { setSearch(""); setVisibility("ALL"); setPage(1); }
  return <section className="story-bible-view author-settings-view library-workspace" data-mobile-detail={mobileDetail}>
    <div className="workspace-heading"><h1>资料</h1></div>
    <KnowledgeSectionNav />
    <div className="library-toolbar" hidden={mobileDetail}>
      <SearchField label="搜索作者设定" placeholder="搜索名称或设定"
        value={search} onChange={(value) => { setSearch(value); setPage(1); }} />
      <select aria-label="设定公开状态" value={visibility} onChange={(event) => { setVisibility(event.target.value); setPage(1); }}>
        <option value="ALL">全部设定</option><option value="AUTHOR_ONLY">作者保留／尚未揭示</option><option value="PUBLIC">可向读者揭示</option>
      </select><span className="library-meta">{filtered.length} 条</span>
    </div>
    {project.isError ? <p className="project-error" role="alert">{errorMessage(project.error)}<button type="button" onClick={() => void project.refetch()}>重试作品信息</button></p> : null}
    <div className="library-layout" data-empty={emptyCollection}><aside ref={navigation.list} hidden={emptyCollection || mobileDetail} className="library-list" aria-label="作者设定列表">
    {settings.isPending ? <p className="plan-empty" role="status">正在加载设定…</p> : null}
    {settings.isError ? <p className="project-error" role="alert">{errorMessage(settings.error)}<button type="button" onClick={() => void settings.refetch()}>重试</button></p> : null}
    {settings.isSuccess && !filtered.length && !emptyCollection ? <div className="library-list-empty">
      <p className="plan-empty">{settings.data.length ? "没有符合条件的作者设定。" : "尚未添加作者设定"}</p>
      {search || visibility !== "ALL" ? <button type="button" className="secondary-action" onClick={resetFilters}>重置筛选</button> : null}</div> : null}
      {filtered.slice(0, page * 100).map((setting) => <button type="button" key={setting.id} className="library-item"
        data-selected={selectedId === setting.id} onClick={() => { navigation.openDetail(); setSelectedId(setting.id); }}>
        <strong>{setting.entityName}</strong><span>{setting.content.slice(0, 70)}</span>
        <small>{setting.visibility === "AUTHOR_ONLY" ? "尚未揭示" : "可揭示"}</small>
      </button>)}
      {filtered.length > page * 100 ? <button type="button" className="secondary-action" onClick={() => setPage((current) => current + 1)}>更多设定</button> : null}
    </aside><div ref={navigation.detail} hidden={!navigation.wide && !navigation.detailOpen} className="library-detail"
      tabIndex={-1} role="region" aria-label="设定揭示详情">
      {!navigation.wide && <button type="button" className="secondary-action library-back" onClick={navigation.closeDetail}><ArrowLeft size={15} />返回设定列表</button>}
      {selected ? <><ContentTypeLabel identity={{ category: "SETTING", subtype: "揭示状态" }} /><h2>{selected.entityName}</h2><p className="library-meta">作者确认 · {selected.visibility === "AUTHOR_ONLY" ? "尚未揭示" : "可向读者揭示"}</p>
        <p className="library-content">{selected.content}</p>
        <div className="library-actions">
          {project.data ? <WorkspaceLink className="secondary-action" href={entityHref(selected.entityId, project.data.projectId, "/knowledge/settings")}><BookOpenText size={15} />查看关联设定</WorkspaceLink> : null}
          <WorkspaceLink className="secondary-action" href={`/discussion#${encodeURIComponent(selected.sessionId)}`}><MessageSquareText size={15} />来源讨论</WorkspaceLink>
        </div><details className="library-advanced"><summary>来源信息</summary><p>来源修订 <code>{selected.entityRevisionId}</code></p><p>整理结果 <code>{selected.sourceProposalId}</code></p></details>
      </> : settings.isSuccess ? <WorkspaceEmptyState icon={emptyCollection && filteredEmpty ? SearchX : Eye}
        title={emptyCollection && filteredEmpty ? "没有符合条件的作者设定。" : !settings.data.length ? "尚未添加作者设定" : "选择一条作者设定"}>
        {emptyCollection && filteredEmpty ? <button type="button" className="secondary-action" onClick={resetFilters}>重置筛选</button> : null}
      </WorkspaceEmptyState> : <div className="library-empty"><p>{settings.isPending ? "正在读取揭示状态…" : "设定暂不可用"}</p></div>}
    </div></div>
  </section>;
}
