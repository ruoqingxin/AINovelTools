import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BookOpenText, Database, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, getCurrentProject, searchProject } from "../lib/tauri-client";
import { manuscriptSourceHref } from "../lib/manuscript-source";
import { entityHref } from "../lib/entity-navigation";
import { materialHref, planNodeHref } from "../lib/knowledge-navigation";
import "./activity-workspace.css";
import { formatSavedAt } from "./project-workspace-utils";

const PAGE_SIZE = 50;

export function highlightSearchSnippet(text: string, keyword: string) {
  if (!keyword.trim()) return text;
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) =>
    index % 2 ? <mark key={index}>{part}</mark> : part);
}

export function SearchView() {
  const resultsPanel = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    const params = new URLSearchParams({ ...(query ? { q: query } : {}), ...(objectType ? { type: objectType } : {}) });
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [query, objectType]);
  useEffect(() => {
    if (resultsPanel.current) resultsPanel.current.scrollTop = 0;
  }, [keyword, objectType]);

  const results = useInfiniteQuery({
    queryKey: ["project-search", project.data?.projectId, keyword, objectType],
    queryFn: ({ pageParam }) => searchProject(keyword, objectType || undefined, PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.length === PAGE_SIZE ? lastOffset + PAGE_SIZE : undefined,
    enabled: keyword.length > 0 && Boolean(project.data),
  });
  const items = results.data?.pages.flat() ?? [];
  const hasQuery = query.trim().length > 0;
  const isDebouncing = keyword !== query.trim();
  const labels: Record<string, string> = { ENTITY: "人物与世界", SUMMARY: "摘要", CARD: "写作卡片", PLAN: "大纲", MANUSCRIPT: "正文修订" };
  return <section className="search-view activity-workspace">
    <div className="workspace-heading"><h1>搜索</h1></div>
    <div className="search-toolbar">
      <label className="search-field"><Search size={15} /><input autoFocus aria-label="搜索项目内容" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label>
      <select aria-label="对象类型筛选" value={objectType} onChange={(event) => setObjectType(event.target.value)}>
        <option value="">可检索内容</option><option value="ENTITY">人物与世界</option><option value="SUMMARY">摘要</option><option value="CARD">写作卡片</option><option value="PLAN">大纲</option><option value="MANUSCRIPT">正文</option>
      </select>
    </div>
    <div className="search-results" ref={resultsPanel}>
      {!hasQuery ? <div className="activity-empty"><Search size={24} /><p>尚未搜索</p></div> : null}
      {hasQuery && (isDebouncing || results.isPending) ? <p className="plan-empty">正在搜索…</p> : null}
      {hasQuery && !isDebouncing && results.isError ? <p className="project-error" role="alert">搜索失败：{errorMessage(results.error)} <a href="/settings#data-management">前往数据管理修复</a></p> : null}
      {hasQuery && !isDebouncing && results.isSuccess && items.length === 0 ? <p className="plan-empty"><Database size={16} />没有匹配结果。</p> : null}
      {hasQuery && !isDebouncing ? items.map((item) => <article className="search-result" key={`${item.objectType}-${item.objectId}`}><div><span className="entity-type-badge">{labels[item.objectType] ?? item.objectType}</span></div>
        <h2>{item.title ?? labels[item.objectType] ?? item.objectType}</h2>
        {item.chapterTitle || item.updatedAt ? <p className="search-result-meta">
          {item.chapterTitle && item.chapterTitle !== item.title ? <span>{item.chapterTitle}</span> : null}
          {item.updatedAt ? <time dateTime={item.updatedAt}>{item.objectType === "MANUSCRIPT" ? "修订于" : "更新于"} {formatSavedAt(item.updatedAt)}</time> : null}
        </p> : null}
        <p>{highlightSearchSnippet(item.snippet, keyword)}</p>
        {item.objectType === "ENTITY" && project.data ? <a className="secondary-action" href={entityHref(item.objectId, project.data.projectId, returnTo)}><BookOpenText size={14} />打开当前实体</a> : null}
        {(item.objectType === "SUMMARY" || item.objectType === "CARD") && project.data ? <a className="secondary-action" href={materialHref(item.objectType, item.objectId, project.data.projectId, returnTo)}><BookOpenText size={14} />{item.objectType === "SUMMARY" ? "打开当前摘要" : "打开当前卡片"}</a> : null}
        {item.objectType === "PLAN" && project.data ? <a className="secondary-action" href={planNodeHref(item.objectId, project.data.projectId, returnTo)}><BookOpenText size={14} />打开当前规划</a> : null}
        {item.objectType === "MANUSCRIPT" && project.data ? <a className="secondary-action" href={manuscriptSourceHref({
          projectId: project.data.projectId, revisionId: item.objectId, ...(item.blockId ? { blockId: item.blockId } : {}),
        }, returnTo)}><BookOpenText size={14} />定位原文</a> : null}
        <details className="activity-advanced"><summary>来源详情</summary><code>{item.sourceVersion ?? "无来源版本"}{item.blockId ? ` · 块 ${item.blockId}` : ""}</code></details>
      </article>) : null}
      {hasQuery && !isDebouncing && results.hasNextPage ? <button type="button" className="secondary-action search-more" disabled={results.isFetching} onClick={() => void results.fetchNextPage()}>{results.isFetchingNextPage ? "正在加载…" : "加载更多"}</button> : null}
    </div>
  </section>;
}
