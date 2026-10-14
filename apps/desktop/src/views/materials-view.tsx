import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, getCurrentProject, listPlanNodes, listSummaryMaterials, listWritingCards, type SummaryMaterial } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { parseMaterialTarget, summaryManuscriptHref } from "../lib/knowledge-navigation";
import { MaterialDetailView } from "./material-detail-view";
import { automaticSummary, MaterialEditor, SummaryActions, summaryLabel, summaryStatus } from "./material-controls";
import { formatSavedAt } from "./project-workspace-utils";
import "./library-workspace.css";

export function MaterialsView() {
  const target = parseMaterialTarget(window.location.search);
  return target ? <MaterialDetailView target={target} /> : <MaterialsManager />;
}
function MaterialsManager() {
  const summaries = useQuery({ queryKey: ["summary-materials"], queryFn: listSummaryMaterials });
  const cards = useQuery({ queryKey: ["writing-cards"], queryFn: () => listWritingCards() });
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const [kind, setKind] = useState<"SUMMARY" | "CARD">("SUMMARY");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editorState, setEditorState] = useState({ dirty: false, busy: false });
  const [actionBusy, setActionBusy] = useState(false);
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes, enabled: kind === "SUMMARY" && Boolean(project.data) });
  const chapterTitles = new Map((nodes.data ?? []).filter((node) => node.kind === "CHAPTER").map((node) => [node.id, node.title]));
  const detail = useRef<HTMLDivElement>(null);
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
    : (cards.data ?? []).map((item) => ({ id: item.id, title: item.title, content: item.content, state: `${item.enabled ? "已启用" : "已停用"} · ${item.cardType === "STYLE_RULE" ? "风格规则" : "写作技巧"}` })))
    .filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(search.trim().toLowerCase()));
  function leaveEditor() { return !actionBusy && !editorState.busy && (!editing || !editorState.dirty || window.confirm("放弃尚未保存的资料修改吗？")); }
  function choose(id: string | null) {
    if (!leaveEditor()) return;
    setSelectedId(id); setCreating(false); setEditing(false); setEditorState({ dirty: false, busy: false });
  }
  return <section className="materials-view library-workspace">
    <div className="workspace-heading"><h1>参考资料</h1></div><KnowledgeSectionNav />
    <div className="library-toolbar">
      <div className="creation-mode" role="group" aria-label="参考资料类型">{(["SUMMARY", "CARD"] as const).map((value) =>
        <button type="button" key={value} disabled={editorState.busy || actionBusy} aria-pressed={kind === value} onClick={() => {
          if (value === kind || !leaveEditor()) return;
          setKind(value); setSelectedId(null); setEditing(false); setCreating(false); setSearch(""); setEditorState({ dirty: false, busy: false });
        }}>{value === "SUMMARY" ? "摘要与记忆" : "写作卡片"}</button>)}</div>
      <label className="search-field"><Search size={15} /><input aria-label="搜索参考资料" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索资料" /></label>
      <button type="button" className="primary-action" disabled={!project.data || editorState.busy || actionBusy} onClick={() => {
        if (!leaveEditor()) return;
        setSelectedId(null); setCreating(true); setEditing(true);
      }}><Plus size={15} />{kind === "SUMMARY" ? "新建参考摘要" : "新建卡片"}</button>
    </div>
    {project.isError ? <p role="alert" className="project-error">{errorMessage(project.error)}<button type="button" onClick={() => void project.refetch()}>重试</button></p> : null}
    <div className="library-layout"><aside className="library-list" aria-label="参考资料列表">
      {query.isPending ? <p role="status">正在读取资料…</p> : null}
      {query.isError ? <p role="alert" className="project-error">{errorMessage(query.error)}<button type="button" onClick={() => void query.refetch()}>重试</button></p> : null}
      {query.isSuccess && !items.length ? <p className="plan-empty">暂无匹配资料</p> : null}
      {items.map((item) => <button key={item.id} type="button" className="library-item" disabled={editorState.busy || actionBusy} data-selected={selectedId === item.id} onClick={() => choose(item.id)}>
        <strong>{item.title}</strong><span>{item.content.slice(0, 90)}</span><small>{item.state}</small></button>)}
    </aside><div ref={detail} className="library-detail">
      {editing && project.data ? <><h2>{creating ? kind === "SUMMARY" ? "新建参考摘要" : "新建卡片" : summary && automaticSummary(summary) ? "另存为参考摘要" : "编辑资料"}</h2>
        <MaterialEditor key={`${kind}:${selectedId ?? "new"}`} kind={kind} projectId={project.data.projectId} summary={summary} card={card}
          onStateChange={setEditorState}
          onSaved={(id) => { setSelectedId(id); setCreating(false); setEditing(false); setEditorState({ dirty: false, busy: false }); }} onCancel={() => { setEditing(false); setCreating(false); setEditorState({ dirty: false, busy: false }); }} />
      </> : summary || card ? <>
        <h2>{card?.title ?? materialTitle(summary!)}</h2><p className="library-meta">{summary ? materialState(summary) : card?.enabled ? "已启用" : "已停用"}</p>
        <p className="library-content">{summary?.content ?? card?.content}</p>
        <button type="button" className="secondary-action" disabled={actionBusy} onClick={() => setEditing(true)}><Pencil size={15} />{summary && automaticSummary(summary) ? "编辑参考副本" : "编辑资料"}</button>
        {summary ? <SummaryActions key={summary.id} item={summary} onBusyChange={setActionBusy} /> : null}
        {summary && summaryManuscriptHref(summary, "/knowledge/materials") ? <div className="library-actions"><a className="secondary-action" href={summaryManuscriptHref(summary, "/knowledge/materials")!}>查看来源正文</a></div> : null}
        <details className="library-advanced"><summary>来源与高级信息</summary><p>来源 <code>{summary?.sourceVersion ?? card?.sourceVersion ?? "未指定"}</code></p>
          {card ? <p>作用范围 <code>{card.scope}</code> · 排序 {card.sortOrder}</p> : null}</details>
      </> : <div className="library-empty"><p>选择一条参考资料</p></div>}
    </div></div>
  </section>;
}
