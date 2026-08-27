import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, BookOpen, Check, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { clearRecoveryLogs, createPlanNode, currentManuscript, errorMessage, listManuscriptRevisions, listPlanNodes, listRecoveryLogs, mergeManuscript, movePlanNode, saveManuscriptChecked, saveRecoveryLog, updatePlanNodeChecked, type ManuscriptRevision, type MergeResult, type PlanNode, type PlanNodeKind } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";

const kindLabels: Record<PlanNodeKind, string> = {
  WORK_DESIGN: "作品设计",
  OUTLINE: "总纲",
  VOLUME: "分卷",
  CHAPTER: "章节",
  SCENE: "场景",
};

function documentToJson(value: string) {
  try {
    const parsed = JSON.parse(value) as { type?: string };
    if (parsed && parsed.type === "doc") return parsed;
  } catch {
    // Existing revisions may contain plain text from the first editor.
  }
  return {
    type: "doc",
    content: value.split(/\r?\n/).map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : undefined,
    })),
  };
}

function documentToText(value: string) {
  try {
    const document = JSON.parse(value) as { content?: Array<{ content?: Array<{ text?: string }> }> };
    return (document.content ?? []).map((block) => (block.content ?? []).map((item) => item.text ?? "").join("" )).join("\n");
  } catch {
    return value;
  }
}

function diffLines(left: string, right: string) {
  try {
    const parse = (value: string) => {
      const doc = JSON.parse(value) as { content?: Array<{ attrs?: { blockId?: string }; content?: Array<{ text?: string }> }> };
      return (doc.content ?? []).map((block, index) => ({ id: block.attrs?.blockId ?? `legacy-${index}`, text: (block.content ?? []).map((item) => item.text ?? "").join("") }));
    };
    const aBlocks = parse(left); const bBlocks = parse(right);
    const rows: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
    const ids = [...new Set([...aBlocks.map((x) => x.id), ...bBlocks.map((x) => x.id)])];
    for (const id of ids) {
      const a = aBlocks.find((x) => x.id === id)?.text; const b = bBlocks.find((x) => x.id === id)?.text;
      if (a === b) rows.push({ kind: "same", text: a ?? "" }); else { if (a !== undefined) rows.push({ kind: "removed", text: a }); if (b !== undefined) rows.push({ kind: "added", text: b }); }
    }
    return rows;
  } catch { /* fall back to legacy line diff */ }
  const a = left.split("\n");
  const b = right.split("\n");
  const rows: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) rows.push({ kind: "same", text: a[index] ?? "" });
    else {
      if (a[index] !== undefined) rows.push({ kind: "removed", text: a[index] });
      if (b[index] !== undefined) rows.push({ kind: "added", text: b[index] });
    }
  }
  return rows;
}

export function ProjectWorkspaceView() {
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const [kind, setKind] = useState<PlanNodeKind>("CHAPTER");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [moveParentId, setMoveParentId] = useState("");
  const [draft, setDraft] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);
  const [chapterTab, setChapterTab] = useState<"editor" | "ai" | "revisions" | "recovery">("editor");
  const editor = useEditor({
    extensions: [StarterKit],
    content: documentToJson(""),
    editorProps: { attributes: { class: "tiptap-editor" } },
    onUpdate: ({ editor: currentEditor }) => setDraft(JSON.stringify(currentEditor.getJSON())),
  });

  async function addNode() {
    if (!title.trim()) return;
    setError(null);
    try {
      await createPlanNode({ kind, title: title.trim(), ...(parentId ? { parentId } : {}) });
      setTitle("");
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(errorMessage(cause));
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
  const recovery = useQuery({ queryKey: ["recovery-logs", selected?.id], queryFn: () => listRecoveryLogs(selected!.id), enabled: selected?.kind === "CHAPTER" });

  useEffect(() => {
    if (selected?.kind === "CHAPTER") {
      const next = manuscript.data?.documentJson ?? "";
      setDraft(next);
      if (editor && next !== JSON.stringify(editor.getJSON())) editor.commands.setContent(documentToJson(next), { emitUpdate: false });
    }
  }, [editor, manuscript.data, selected?.kind, selected?.id]);

  useEffect(() => {
    if (history.data && history.data!.length >= 2 && (!compareLeftId || !compareRightId)) {
      setCompareLeftId(history.data[1].id);
      setCompareRightId(history.data[0].id);
    }
  }, [history.data, compareLeftId, compareRightId]);

  useEffect(() => {
    if (!selected || selected.kind !== "CHAPTER" || !draft.trim() || draft === (manuscript.data?.documentJson ?? "")) return;
    const timer = window.setTimeout(() => { void saveRecoveryLog({ chapterId: selected.id, documentJson: draft }); }, 5000);
    return () => window.clearTimeout(timer);
  }, [draft, manuscript.data?.documentJson, selected]);

  useEffect(() => {
    const dirty = Boolean(selected?.kind === "CHAPTER" && draft.trim() && draft !== (manuscript.data?.documentJson ?? ""));
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [draft, manuscript.data?.documentJson, selected]);

  async function saveSelected() {
    if (!selected || !editTitle.trim()) return;
    setError(null);
    try {
      await updatePlanNodeChecked({ id: selected.id, title: editTitle.trim(), archived: selected.archived, expectedVersion: selected.revision });
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function toggleArchived(node: PlanNode) {
    setError(null);
    try {
      await updatePlanNodeChecked({ id: node.id, title: node.title, archived: !node.archived, expectedVersion: node.revision });
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function saveDraft() {
    if (!selected || selected.kind !== "CHAPTER" || !draft.trim()) return;
    setSavingDraft(true);
    setError(null);
    try {
      await saveManuscriptChecked({ chapterId: selected.id, baseRevisionId: manuscript.data?.id, documentJson: draft, creationReason: "MANUAL_SAVE" });
      await clearRecoveryLogs(selected.id);
      await client.invalidateQueries({ queryKey: ["manuscript", selected.id] });
      await client.invalidateQueries({ queryKey: ["manuscript-history", selected.id] });
      await client.invalidateQueries({ queryKey: ["recovery-logs", selected.id] });
      await client.invalidateQueries({ queryKey: ["recovery-all"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingDraft(false);
    }
  }

  async function recoverLatest() {
    const latest = recovery.data?.[0];
    if (!latest || !selected) return;
    setDraft(latest.documentJson);
    if (editor) editor.commands.setContent(documentToJson(latest.documentJson), { emitUpdate: false });
  }

  async function mergeDraft() {
    if (!selected || !manuscript.data || !draft.trim()) return;
    const base = history.data?.find((item) => item.id === manuscript.data?.parentRevisionId);
    if (!base) { setError("缺少合并基线版本"); return; }
    try { setMergeResult(await mergeManuscript({ base: base.documentJson, current: manuscript.data.documentJson, draft })); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  async function restoreRevision(revision: ManuscriptRevision) {
    if (!selected || selected.kind !== "CHAPTER") return;
    setDraft(revision.documentJson);
    setError(null);
    try {
      await saveManuscriptChecked({ chapterId: selected.id, baseRevisionId: manuscript.data?.id, documentJson: revision.documentJson, creationReason: "RESTORE_REVISION" });
      await clearRecoveryLogs(selected.id);
      await client.invalidateQueries({ queryKey: ["manuscript", selected.id] });
      await client.invalidateQueries({ queryKey: ["manuscript-history", selected.id] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function selectNode(node: PlanNode) {
    if (selected?.kind === "CHAPTER" && draft.trim() && draft !== (manuscript.data?.documentJson ?? "") && !window.confirm("当前正文有未保存修改，确定切换吗？")) return;
    setSelectedId(node.id);
    setEditTitle(node.title);
    setMoveParentId(node.parentId ?? "");
    setChapterTab("editor");
  }

  async function moveSelected() {
    if (!selected) return;
    try { await movePlanNode({ id: selected.id, ...(moveParentId ? { parentId: moveParentId } : {}), expectedVersion: selected.revision }); await client.invalidateQueries({ queryKey: ["plan-nodes"] }); }
    catch (cause) { setError(errorMessage(cause)); }
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
        <h1>作品规划与创作</h1>
        <p className="workspace-lede">左侧管理故事结构，右侧专注当前节点。规划、正文、AI 和修订彼此分开，工作状态保持连续。</p>
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

      <div className="plan-layout">
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
          <button type="button" className="primary-action" onClick={() => void saveSelected()} disabled={!editTitle.trim()}><Check size={15} />保存标题</button>
          <button type="button" className="secondary-action" onClick={() => void toggleArchived(selected)}>{selected.archived ? <RotateCcw size={15} /> : <Archive size={15} />}{selected.archived ? "恢复节点" : "归档节点"}</button>
        </div>
        <div className="inspector-actions"><select value={moveParentId} onChange={(event) => setMoveParentId(event.target.value)} aria-label="移动到父节点"><option value="">移动到顶层</option>{(nodes.data ?? []).filter((node) => node.id !== selected.id && !node.archived).map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select><button type="button" className="secondary-action" onClick={() => void moveSelected()}>移动节点</button></div>
        {selected.kind === "CHAPTER" ? <div className="chapter-editor">
          <div className="section-heading"><h2>章节工作区</h2><span>{manuscript.data ? "已有修订" : "尚未保存"}</span></div>
          <div className="chapter-tabs" role="tablist" aria-label="章节工作区页签">
            {([['editor', '正文编辑'], ['ai', 'AI 创作'], ['revisions', '修订与冲突'], ['recovery', '恢复草稿']] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={chapterTab === value} data-active={chapterTab === value || undefined} key={value} onClick={() => setChapterTab(value)}>{label}</button>)}
          </div>
          {chapterTab === "editor" ? <div className="chapter-tab-panel">
            {editor ? <>
              <div className="editor-toolbar" aria-label="编辑器工具栏">
                <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} data-active={editor.isActive("bold") || undefined} aria-label="粗体">B</button>
                <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} data-active={editor.isActive("italic") || undefined} aria-label="斜体"><em>I</em></button>
                <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} data-active={editor.isActive("bulletList") || undefined} aria-label="项目列表">•</button>
              </div>
              <EditorContent editor={editor} />
            </> : <p className="plan-empty">正在加载编辑器…</p>}
            <button type="button" className="primary-action" onClick={() => void saveDraft()} disabled={savingDraft || !draft.trim()}>{savingDraft ? "保存中…" : "保存正文修订"}</button>
          </div> : null}
          {chapterTab === "ai" ? <AiWritingPanel chapterId={selected.id} chapterTitle={selected.title} chapterPlan={selected.title} draft={draft} editor={editor} /> : null}
          {chapterTab === "revisions" ? <div className="chapter-tab-panel">
            <button type="button" className="secondary-action" onClick={() => void mergeDraft()} disabled={!manuscript.data || !draft.trim()}>检查并合并冲突</button>
            {mergeResult ? <div className="merge-panel"><div className="section-heading"><h3>{mergeResult.conflicts.length ? `发现 ${mergeResult.conflicts.length} 个冲突块` : "没有发现冲突"}</h3>{!mergeResult.conflicts.length ? <button type="button" className="secondary-action" onClick={() => { setDraft(mergeResult.documentJson); if (editor) editor.commands.setContent(documentToJson(mergeResult.documentJson), { emitUpdate: false }); }}>应用合并结果</button> : null}</div>{mergeResult.conflicts.map((conflict) => <div className="merge-conflict" key={conflict.blockId}><code>{conflict.blockId}</code><span>当前版本与草稿都修改了该段，请在编辑器中手工选择后再保存。</span></div>)}</div> : null}
            <div className="revision-history">
              <div className="section-heading"><h2>修订历史</h2><span>{history.data?.length ?? 0} 条</span></div>
              {history.data?.map((revision, index) => <div className="revision-row" key={revision.id}><span>修订 {history.data!.length - index}</span><code>{revision.contentHash}</code><button type="button" className="secondary-action" onClick={() => void restoreRevision(revision)}>恢复为新正文</button></div>)}
              {(history.data?.length ?? 0) < 2 ? <p className="revision-hint">保存两次正文后，可以在这里选择两个版本进行差异对比。</p> : (
                <div className="revision-compare">
                  <div className="compare-selects">
                    <select value={compareLeftId ?? ""} onChange={(event) => setCompareLeftId(event.target.value)} aria-label="较早修订"><option value="">选择较早修订</option>{history.data?.map((revision, index) => <option key={revision.id} value={revision.id}>修订 {history.data!.length - index}</option>)}</select>
                    <span>对比</span>
                    <select value={compareRightId ?? ""} onChange={(event) => setCompareRightId(event.target.value)} aria-label="较新修订"><option value="">选择较新修订</option>{history.data?.map((revision, index) => <option key={revision.id} value={revision.id}>修订 {history.data!.length - index}</option>)}</select>
                  </div>
                  {compareLeftId && compareRightId ? <div className="diff-view">{diffLines(documentToText(history.data!.find((revision) => revision.id === compareLeftId)?.documentJson ?? ""), documentToText(history.data!.find((revision) => revision.id === compareRightId)?.documentJson ?? "")).map((row, index) => <div className={`diff-line diff-${row.kind}`} key={`${index}-${row.kind}`}><span>{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span><code>{row.text || " "}</code></div>)}</div> : null}
                </div>
              )}
            </div>
          </div> : null}
          {chapterTab === "recovery" ? <div className="chapter-tab-panel">{recovery.data?.length ? <div className="recovery-banner"><span>发现 {recovery.data.length} 条可恢复草稿</span><button type="button" className="secondary-action" onClick={() => void recoverLatest()}>恢复最近草稿</button></div> : <div className="plan-empty">当前没有可恢复的草稿。</div>}</div> : null}
        </div> : null}
      </aside> : <div className="plan-inspector plan-inspector-empty"><BookOpen size={24} /><h2>选择一个规划节点</h2><p>从左侧选择章节开始编辑正文，或选择其他节点查看详情。</p></div>}
      </div>
    </section>
  );
}
