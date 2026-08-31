import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { rebuildSearchIndex, searchProject } from "../lib/tauri-client";

export function SearchView() {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [objectType, setObjectType] = useState("");
  const [offset, setOffset] = useState(0);
  const results = useQuery({ queryKey: ["project-search", query, objectType, offset], queryFn: () => searchProject(query, objectType || undefined, 50, offset), enabled: query.trim().length > 0 });
  return <section className="search-view">
    <div className="workspace-heading"><p className="eyebrow">R4 阶段 E</p><h1>项目搜索</h1><p className="workspace-lede">搜索实体、摘要、写作卡片、规划和正文修订。短查询会自动使用受限回退。</p></div>
    <div className="search-toolbar"><label className="search-field"><Search size={15} /><input aria-label="搜索项目内容" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} placeholder="输入关键词" /></label><select aria-label="对象类型筛选" value={objectType} onChange={(e) => { setObjectType(e.target.value); setOffset(0); }}><option value="">全部对象</option><option value="ENTITY">实体</option><option value="SUMMARY">摘要</option><option value="CARD">卡片</option><option value="PLAN">规划</option><option value="MANUSCRIPT">正文</option></select><button type="button" className="secondary-action" onClick={() => void rebuildSearchIndex().then(() => client.invalidateQueries({ queryKey: ["project-search"] }))}><RefreshCw size={15} />重建索引</button></div>
    <div className="search-results">{results.isPending && query.trim() ? <p className="plan-empty">正在搜索…</p> : null}{results.isError ? <p className="project-error" role="alert">搜索失败：{String(results.error)}</p> : null}{!results.isPending && query.trim() && results.data?.length === 0 && offset === 0 ? <p className="plan-empty"><Database size={16} />没有匹配结果。</p> : null}{results.data?.map((item) => <article className="search-result" key={`${item.objectType}-${item.objectId}`}><div><span className="entity-type-badge">{item.objectType}</span><code>{item.sourceVersion ?? "无来源版本"}</code></div><p>{item.snippet}</p></article>)}{results.data && results.data.length === 50 ? <button type="button" className="secondary-action search-more" onClick={() => setOffset((value) => value + 50)}>加载更多</button> : null}</div>
  </section>;
}
