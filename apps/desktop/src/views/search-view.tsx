import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Database, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, rebuildSearchIndex, searchProject } from "../lib/tauri-client";

const PAGE_SIZE = 50;

export function SearchView() {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [objectType, setObjectType] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useInfiniteQuery({
    queryKey: ["project-search", keyword, objectType],
    queryFn: ({ pageParam }) => searchProject(keyword, objectType || undefined, PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.length === PAGE_SIZE ? lastOffset + PAGE_SIZE : undefined,
    enabled: keyword.length > 0,
  });
  const rebuild = useMutation({
    mutationFn: rebuildSearchIndex,
    onSuccess: () => client.invalidateQueries({ queryKey: ["project-search"] }),
  });
  const items = results.data?.pages.flat() ?? [];
  const hasQuery = query.trim().length > 0;
  const isDebouncing = keyword !== query.trim();
  return <section className="search-view">
    <div className="workspace-heading"><p className="eyebrow">项目导航</p><h1>项目搜索</h1><p className="workspace-lede">搜索实体、摘要、写作卡片、规划和正文修订。短查询会自动使用受限回退。</p></div>
    <div className="search-toolbar">
      <label className="search-field"><Search size={15} /><input aria-label="搜索项目内容" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label>
      <select aria-label="对象类型筛选" value={objectType} onChange={(event) => setObjectType(event.target.value)}>
        <option value="">全部对象</option><option value="ENTITY">实体</option><option value="SUMMARY">摘要</option><option value="CARD">卡片</option><option value="PLAN">规划</option><option value="MANUSCRIPT">正文</option>
      </select>
      <button type="button" className="secondary-action" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}><RefreshCw size={15} />{rebuild.isPending ? "正在重建…" : "重建索引"}</button>
    </div>
    {rebuild.isError ? <p className="project-error" role="alert">索引重建失败：{errorMessage(rebuild.error)}</p> : null}
    <div className="search-results">
      {hasQuery && (isDebouncing || results.isPending) ? <p className="plan-empty">正在搜索…</p> : null}
      {hasQuery && !isDebouncing && results.isError ? <p className="project-error" role="alert">搜索失败：{errorMessage(results.error)}</p> : null}
      {hasQuery && !isDebouncing && results.isSuccess && items.length === 0 ? <p className="plan-empty"><Database size={16} />没有匹配结果。</p> : null}
      {hasQuery && !isDebouncing ? items.map((item) => <article className="search-result" key={`${item.objectType}-${item.objectId}`}><div><span className="entity-type-badge">{item.objectType}</span><code>{item.sourceVersion ?? "无来源版本"}{item.blockId ? ` · 块 ${item.blockId}` : ""}</code></div><p>{item.snippet}</p></article>) : null}
      {hasQuery && !isDebouncing && results.hasNextPage ? <button type="button" className="secondary-action search-more" disabled={results.isFetching} onClick={() => void results.fetchNextPage()}>{results.isFetchingNextPage ? "正在加载…" : "加载更多"}</button> : null}
    </div>
  </section>;
}
