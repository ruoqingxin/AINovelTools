import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, getCurrentProject, listPlanNodes, listSummaryMaterials, listWritingCards, type SummaryMaterial } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { parseMaterialTarget, summaryManuscriptHref } from "../lib/knowledge-navigation";
import { MaterialDetailView } from "./material-detail-view";
import { automaticSummary, MaterialEditor, SummaryActions, summaryLabel, summaryStatus } from "./material-controls";
import { formatSavedAt } from "./project-workspace-utils";
import { useWideWorkspace } from "./workspace-panel";
import "./library-workspace.css";
import { SearchField } from "./search-field";
import { summaryIdentity, writingCardTypeLabels } from "../lib/content-taxonomy";
import { AiWorkspaceLink, ContentTypeLabel, useInAiWorkspace } from "./content-identity";

export function MaterialsView() {
  const target = parseMaterialTarget(window.location.search);
  return target ? <MaterialDetailView target={target} /> : <MaterialsManager />;
}
function MaterialsManager() {
  const aiWorkspace = useInAiWorkspace();
  const summaries = useQuery({ queryKey: ["summary-materials"], queryFn: listSummaryMaterials });
  const cards = useQuery({ queryKey: ["writing-cards"], queryFn: () => listWritingCards() });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const [kind, setKind] = useState<"SUMMARY" | "CARD">(() => new URLSearchParams(window.location.search).get("materialKind") === "CARD" ? "CARD" : "SUMMARY");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(aiWorkspace && new URLSearchParams(window.location.search).get("action") === "new");
  const [creating, setCreating] = useState(editing);
  const [editorState, setEditorState] = useState({ dirty: false, busy: false });
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wide = useWideWorkspace(851);
  const [detailOpen, setDetailOpen] = useState(editing);
  const [visibleCount, setVisibleCount] = useState(100);
  const list = useRef<HTMLElement>(null);
  const listPosition = useRef({ list: 0, workspace: 0 });
  useEffect(() => { setVisibleCount(100); }, [kind, search]);
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes, enabled: kind === "SUMMARY" && Boolean(project.data) });
  const chapterTitles = new Map((nodes.data ?? []).filter((node) => node.kind === "CHAPTER").map((node) => [node.id, node.title]));
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wide && detailOpen && !editing) detail.current?.focus({ preventScroll: true });
  }, [wide, detailOpen, editing]);
  useEffect(() => {
    if ((selectedId || editing) && window.matchMedia?.("(max-width: 850px)").matches) {
      detail.current?.scrollIntoView?.({ block: "start" });
    }
  }, [selectedId, editing]);
  function materialTitle(item: SummaryMaterial) {
    const chapterTitle = item.kind === "CHAPTER" && item.sourceId ? chapterTitles.get(item.sourceId) : undefined;
    return `${summaryLabel(item)}${chapterTitle ? ` · ${chapterTitle}` : ""}`;
  }
  function materialState(item: SummaryMaterial) {
    return `${summaryStatus(item)}${item.updatedAt && !Number.isNaN(new Date(item.updatedAt).getTime()) ? ` · 更新于 ${formatSavedAt(item.updatedAt)}` : ""}`;
  }
  const summary = kind === "SUMMARY" ? summaries.data?.find((item) => item.id === selectedId) : undefined;
  const card = kind === "CARD" ? cards.data?.find((item) => item.id === selectedId) : undefined;
  const query = kind === "SUMMARY" ? summaries : cards;
  const items = (kind === "SUMMARY" ? (summaries.data ?? []).map((item) => ({ id: item.id, title: materialTitle(item), content: item.content, state: materialState(item) }))
    : (cards.data ?? []).map((item) => ({ id: item.id, title: item.title, content: item.content, state: `${item.enabled ? "已启用" : "已停用"} · ${writingCardTypeLabels[item.cardType]}` })))
    .filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(search.trim().toLowerCase()));
  function leaveEditor() { return !actionBusy && !editorState.busy && (!editing || !editorState.dirty || window.confirm("放弃尚未保存的资料修改吗？")); }
  function choose(id: string | null) {
    if (id === selectedId) return;
    if (!leaveEditor()) return;
    listPosition.current = { list: list.current?.scrollTop ?? 0, workspace: document.querySelector(".workspace")?.scrollTop ?? 0 };
    setDetailOpen(true);
    setSelectedId(id); setCreating(false); setEditing(false); setNotice(null); setEditorState({ dirty: false, busy: false });
  }
  function returnToList() {
    if (!leaveEditor()) return;
    setDetailOpen(false); setEditing(false); setCreating(false);
    window.requestAnimationFrame(() => {
      if (list.current) list.current.scrollTop = listPosition.current.list;
      const workspace = document.querySelector(".workspace");
      if (workspace) workspace.scrollTop = listPosition.current.workspace;
      list.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus({ preventScroll: true });
    });
  }
  return <section className="materials-view library-workspace" data-mobile-detail={!wide && detailOpen}>
    <div className="workspace-heading"><h1>辅助参考</h1></div><KnowledgeSectionNav />
    <div className="library-toolbar">
      <div className="creation-mode" role="group" aria-label="参考资料类型">{(["SUMMARY", "CARD"] as const).map((value) =>
        <button type="button" key={value} disabled={editorState.busy || actionBusy} aria-pressed={kind === value} onClick={() => {
          if (value === kind || !leaveEditor()) return;
          setKind(value); setSelectedId(null); setDetailOpen(false); setEditing(false); setCreating(false); setNotice(null); setSearch(""); setEditorState({ dirty: false, busy: false });
        }}>{value === "SUMMARY" ? "摘要与记忆" : "写作卡片"}</button>)}</div>
      <SearchField label="搜索参考资料" value={search} onChange={setSearch} placeholder="搜索资料" />
      {!aiWorkspace && project.data ? <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "materials", materialKind: kind, action: "new" }}>
        {kind === "SUMMARY" ? "去构思新建参考摘要" : "去构思新建写作参考"}
      </AiWorkspaceLink> : null}
      {aiWorkspace && <button type="button" className="primary-action" disabled={!project.data || creating || editorState.busy || actionBusy} onClick={() => {
        if (!leaveEditor()) return;
        listPosition.current = { list: list.current?.scrollTop ?? 0, workspace: document.querySelector(".workspace")?.scrollTop ?? 0 };
        setDetailOpen(true);
        setSelectedId(null); setCreating(true); setEditing(true); setNotice(null);
      }}><Plus size={15} />{kind === "SUMMARY" ? "新建参考摘要" : "新建卡片"}</button>}
    </div>
    {project.isError ? <p role="alert" className="project-error">{errorMessage(project.error)}<button type="button" onClick={() => void project.refetch()}>重试</button></p> : null}
    <div className="library-layout"><aside ref={list} hidden={!wide && detailOpen} className="library-list" aria-label="参考资料列表">
      {query.isPending ? <p role="status">正在读取资料…</p> : null}
      {query.isError ? <p role="alert" className="project-error">{errorMessage(query.error)}<button type="button" onClick={() => void query.refetch()}>重试</button></p> : null}
      {query.isSuccess && !items.length ? <div className="library-list-empty"><p className="plan-empty">{search.trim() ? "没有匹配资料" : kind === "SUMMARY" ? "暂无摘要与记忆" : "暂无写作卡片"}</p>
        {search.trim() ? <button type="button" className="secondary-action" onClick={() => setSearch("")}>清空搜索</button> : null}</div> : null}
      {items.slice(0, visibleCount).map((item) => <button key={item.id} type="button" className="library-item" disabled={editorState.busy || actionBusy} data-selected={selectedId === item.id} onClick={() => choose(item.id)}>
        <strong>{item.title}</strong><span>{item.content.slice(0, 90)}</span><small>{item.state}</small></button>)}
      {items.length > visibleCount ? <button type="button" className="secondary-action" onClick={() => setVisibleCount((count) => count + 100)}>显示更多资料</button> : null}
    </aside><div ref={detail} hidden={!wide && !detailOpen} className="library-detail" tabIndex={-1} role="region" aria-label="参考资料详情">
      {!wide ? <button type="button" className="secondary-action library-back" disabled={actionBusy || editorState.busy} onClick={returnToList}><ArrowLeft size={15} />返回资料列表</button> : null}
      {notice ? <p role="status" className="project-notice">{notice}</p> : null}
      {editing && project.data ? <><h2>{creating ? kind === "SUMMARY" ? "新建参考摘要" : "新建卡片" : summary && automaticSummary(summary) ? "另存为参考摘要" : "编辑资料"}</h2>
        <MaterialEditor key={`${kind}:${selectedId ?? "new"}`} kind={kind} projectId={project.data.projectId} summary={summary} card={card}
          onStateChange={setEditorState}
          onSaved={(id) => {
            setNotice(summary && automaticSummary(summary) ? "参考副本已保存，原摘要未改动。" : kind === "CARD" ? "写作卡片已保存" : "参考摘要已保存");
            setSelectedId(id); setCreating(false); setEditing(false); setEditorState({ dirty: false, busy: false });
          }} onCancel={() => { setEditing(false); setCreating(false); if (!selectedId) setDetailOpen(false); setEditorState({ dirty: false, busy: false }); }} />
      </> : summary || card ? <>
        <ContentTypeLabel identity={summary ? summaryIdentity(summary) : { category: "REFERENCE", subtype: writingCardTypeLabels[card!.cardType] }} />
        <h2>{card?.title ?? materialTitle(summary!)}</h2><p className="library-meta">{summary ? materialState(summary) : card?.enabled ? "已启用" : "已停用"}</p>
        <p className="library-content">{summary?.content ?? card?.content}</p>
        {aiWorkspace ? <button type="button" className="secondary-action" disabled={actionBusy} onClick={() => { setEditing(true); setNotice(null); }}><Pencil size={15} />{summary && automaticSummary(summary) ? "编辑参考副本" : "编辑资料"}</button>
          : project.data && <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "materials", targetId: selectedId!, materialKind: kind }}>去构思处理{summary ? summaryLabel(summary) : writingCardTypeLabels[card!.cardType]}</AiWorkspaceLink>}
        {summary ? <SummaryActions key={summary.id} item={summary} onBusyChange={setActionBusy} /> : null}
        {summary && summaryManuscriptHref(summary, "/knowledge/materials") ? <div className="library-actions"><a className="secondary-action" href={summaryManuscriptHref(summary, "/knowledge/materials")!}>查看来源正文</a></div> : null}
        <details className="library-advanced"><summary>来源与高级信息</summary><p>来源 <code>{summary?.sourceVersion ?? card?.sourceVersion ?? "未指定"}</code></p>
          {card ? <p>作用范围 <code>{card.scope}</code> · 排序 {card.sortOrder}</p> : null}</details>
      </> : <div className="library-empty"><p>{query.isPending ? "正在读取资料…" : query.isError ? "资料暂不可用"
        : !(query.data?.length) ? kind === "SUMMARY" ? "尚未添加摘要与记忆" : "尚未添加写作卡片" : "选择一条参考资料"}</p></div>}
    </div></div>
  </section>;
}
