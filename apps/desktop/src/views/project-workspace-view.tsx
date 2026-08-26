import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, BookOpen, Check, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPlanNode, currentManuscript, listManuscriptRevisions, listPlanNodes, saveManuscript, updatePlanNode, type ManuscriptRevision, type PlanNode, type PlanNodeKind } from "../lib/tauri-client";

const kindLabels: Record<PlanNodeKind, string> = {
  WORK_DESIGN: "作品设计",
  OUTLINE: "总纲",
  VOLUME: "分卷",
  CHAPTER: "章节",
  SCENE: "场景",
};

export function ProjectWorkspaceView() {
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const [kind, setKind] = useState<PlanNodeKind>("CHAPTER");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addNode() {
    if (!title.trim()) return;
    setError(null);
    try {
      await createPlanNode({ kind, title: title.trim(), ...(parentId ? { parentId } : {}) });
      setTitle("");
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const selected = nodes.data?.find((node) => node.id === selectedId) ?? null;
  const manuscript = useQuery({
    queryKey: ["manuscript", selected?.id],
    queryFn: () => currentManuscript(selected!.id),
    enabled: selected?.kind === "CHAPTER",
  });
  const history = useQuery({
    queryKey: ["manuscript-history", selected?.id],
    queryFn: () => listManuscriptRevisions(selected!.id),
    enabled: selected?.kind === "CHAPTER",
  });

  useEffect(() => {
    if (selected?.kind === "CHAPTER") setDraft(manuscript.data?.documentJson ?? "");
  }, [manuscript.data, selected?.kind, selected?.id]);

  async function saveSelected() {
    if (!selected || !editTitle.trim()) return;
    setError(null);
    try {
      await updatePlanNode({ id: selected.id, title: editTitle.trim(), archived: selected.archived });
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function toggleArchived(node: PlanNode) {
    setError(null);
    try {
      await updatePlanNode({ id: node.id, title: node.title, archived: !node.archived });
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveDraft() {
    if (!selected || selected.kind !== "CHAPTER" || !draft.trim()) return;
    setSavingDraft(true);
    setError(null);
    try {
      await saveManuscript({ chapterId: selected.id, documentJson: draft, creationReason: "MANUAL_SAVE" });
      await client.invalidateQueries({ queryKey: ["manuscript", selected.id] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingDraft(false);
    }
  }

  async function restoreRevision(revision: ManuscriptRevision) {
    if (!selected || selected.kind !== "CHAPTER") return;
    setDraft(revision.documentJson);
    setError(null);
    try {
      await saveManuscript({ chapterId: selected.id, documentJson: revision.documentJson, creationReason: "RESTORE_REVISION" });
      await client.invalidateQueries({ queryKey: ["manuscript", selected.id] });
      await client.invalidateQueries({ queryKey: ["manuscript-history", selected.id] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function selectNode(node: PlanNode) {
    setSelectedId(node.id);
    setEditTitle(node.title);
  }

  function renderTree(parent: string | null, depth = 0): ReactNode[] {
    return (nodes.data ?? [])
      .filter((node) => node.parentId === parent)
      .map((node) => (
        <div key={node.id}>
          <button type="button" className="plan-row" data-selected={selectedId === node.id || undefined} data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => selectNode(node)}>
            <span className="plan-kind">{kindLabels[node.kind]}</span><span>{node.title}</span>
          </button>
          {renderTree(node.id, depth + 1)}
        </div>
      ));
  }

  return (
    <section className="project-workspace">
      <div className="workspace-heading">
        <p className="eyebrow">规划工作区</p>
        <h1>开始搭建你的故事</h1>
        <p className="workspace-lede">先建立作品设计、分卷和章节结构，规划与正文会保持清晰分离。</p>
      </div>

      <div className="plan-create-row">
        <select value={kind} onChange={(event) => setKind(event.target.value as PlanNodeKind)} aria-label="节点类型">
          {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={parentId} onChange={(event) => setParentId(event.target.value)} aria-label="父节点">
          <option value="">作为顶层节点</option>
          {(nodes.data ?? []).filter((node) => !node.archived).map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}
        </select>
        <input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addNode(); }} placeholder="例如：第一卷·启程" aria-label="节点标题" />
        <button type="button" className="primary-action" onClick={() => void addNode()} disabled={!title.trim()}><Plus size={16} />新建节点</button>
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}

      <div className="plan-tree" aria-label="规划树">
        <div className="section-heading"><h2>规划树</h2><span>{nodes.data?.length ?? 0} 个节点</span></div>
        {nodes.isPending ? <p className="plan-empty">正在加载规划…</p> : null}
        {nodes.isError ? <p className="project-error" role="alert">无法加载规划：{String(nodes.error)}</p> : null}
        {nodes.data?.length === 0 ? <div className="plan-empty"><BookOpen size={20} /><p>还没有规划节点，从上方创建第一章吧。</p></div> : null}
        {nodes.data && nodes.data.length > 0 ? renderTree(null) : null}
      </div>

      {selected ? <aside className="plan-inspector" aria-label="节点详情">
        <div className="section-heading"><h2>节点详情</h2><span>修订 {selected.revision}</span></div>
        <p className="inspector-kind">{kindLabels[selected.kind]}</p>
        <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="编辑节点标题" />
        <div className="inspector-actions">
          <button type="button" className="primary-action" onClick={() => void saveSelected()} disabled={!editTitle.trim()}><Check size={15} />保存</button>
          <button type="button" className="secondary-action" onClick={() => void toggleArchived(selected)}>{selected.archived ? <RotateCcw size={15} /> : <Archive size={15} />}{selected.archived ? "恢复" : "归档"}</button>
        </div>
        {selected.kind === "CHAPTER" ? <div className="chapter-editor">
          <div className="section-heading"><h2>正文草稿</h2><span>{manuscript.data ? "已有修订" : "尚未保存"}</span></div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="从这里开始写这一章……" aria-label="正文草稿" />
          <button type="button" className="primary-action" onClick={() => void saveDraft()} disabled={savingDraft || !draft.trim()}>{savingDraft ? "保存中…" : "保存为新修订"}</button>
          {history.data && history.data.length > 0 ? <div className="revision-history"><div className="section-heading"><h2>修订历史</h2><span>{history.data.length} 条</span></div>{history.data.map((revision, index) => <div className="revision-row" key={revision.id}><span>修订 {history.data.length - index}</span><code>{revision.contentHash}</code><button type="button" className="secondary-action" onClick={() => void restoreRevision(revision)}>恢复为新草稿</button></div>)}</div> : null}
        </div> : null}
      </aside> : null}
    </section>
  );
}
