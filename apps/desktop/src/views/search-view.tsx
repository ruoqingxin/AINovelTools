import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, Database, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, getCurrentProject, rebuildSearchIndex, searchProject } from "../lib/tauri-client";
import { manuscriptSourceHref } from "../lib/manuscript-source";
import { entityHref } from "../lib/entity-navigation";
import { materialHref, planNodeHref } from "../lib/knowledge-navigation";

const PAGE_SIZE = 50;

export function SearchView() {
  const client = useQueryClient();
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [keyword, setKeyword] = useState(() => query.trim());
  const [objectType, setObjectType] = useState(() => {
    const type = new URLSearchParams(window.location.search).get("type") ?? "";
    return ["ENTITY", "SUMMARY", "CARD", "PLAN", "MANUSCRIPT"].includes(type) ? type : "";
  });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, staleTime: 30_000 });
  const returnParams = new URLSearchParams({ q: query, ...(objectType ? { type: objectType } : {}) });
  const returnTo = `/search?${returnParams.toString()}`;

  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useInfiniteQuery({
    queryKey: ["project-search", project.data?.projectId, keyword, objectType],
    queryFn: ({ pageParam }) => searchProject(keyword, objectType || undefined, PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.length === PAGE_SIZE ? lastOffset + PAGE_SIZE : undefined,
    enabled: keyword.length > 0 && Boolean(project.data),
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
      {hasQuery && !isDebouncing ? items.map((item) => <article className="search-result" key={`${item.objectType}-${item.objectId}`}><div><span className="entity-type-badge">{item.objectType}</span><code>{item.sourceVersion ?? "无来源版本"}{item.blockId ? ` · 块 ${item.blockId}` : ""}</code></div><p>{item.snippet}</p>
        {item.objectType === "ENTITY" && project.data ? <a className="secondary-action" href={entityHref(item.objectId, project.data.projectId, returnTo)}><BookOpenText size={14} />打开当前实体</a> : null}
        {(item.objectType === "SUMMARY" || item.objectType === "CARD") && project.data ? <a className="secondary-action" href={materialHref(item.objectType, item.objectId, project.data.projectId, returnTo)}><BookOpenText size={14} />{item.objectType === "SUMMARY" ? "打开当前摘要" : "打开当前卡片"}</a> : null}
        {item.objectType === "PLAN" && project.data ? <a className="secondary-action" href={planNodeHref(item.objectId, project.data.projectId, returnTo)}><BookOpenText size={14} />打开当前规划</a> : null}
        {item.objectType === "MANUSCRIPT" && project.data ? <a className="secondary-action" href={manuscriptSourceHref({
          projectId: project.data.projectId, revisionId: item.objectId, ...(item.blockId ? { blockId: item.blockId } : {}),
        }, returnTo)}><BookOpenText size={14} />定位原文</a> : null}
      </article>) : null}
      {hasQuery && !isDebouncing && results.hasNextPage ? <button type="button" className="secondary-action search-more" disabled={results.isFetching} onClick={() => void results.fetchNextPage()}>{results.isFetchingNextPage ? "正在加载…" : "加载更多"}</button> : null}
    </div>
  </section>;
}
