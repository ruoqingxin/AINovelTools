import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, Eye, EyeOff, FileCheck2, Plus, Sparkles, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { clearRecoveryLogs, createPlanNode, currentManuscript, errorMessage, listManuscriptRevisions, listPlanningSections, listPlanNodes, listRecoveryLogs, mergeManuscript, movePlanNode, saveManuscriptChecked, saveRecoveryLog, updatePlanNodeChecked, type ManuscriptRevision, type MergeResult, type PlanNode, type PlanNodeKind } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";
import { ChapterWorkspaceTabs, type ChapterWorkspaceTab } from "./chapter-workspace-tabs";
import { planningSectionGroups, StoryPlanningWorkbench } from "./story-planning-workbench";

const kindLabels: Record<PlanNodeKind, string> = {
  WORK_DESIGN: "作品设计",
  OUTLINE: "总纲",
  VOLUME: "分卷",
  CHAPTER: "章节",
  SCENE: "场景",
};

const rootDefinitions: Array<{ kind: PlanNodeKind; label: string }> = [
  { kind: "WORK_DESIGN", label: "作品设计" },
  { kind: "OUTLINE", label: "故事大纲" },
];

function isRootKind(kind: PlanNodeKind) {
  return kind === "WORK_DESIGN" || kind === "OUTLINE";
}

function isValidParentKind(parent: PlanNodeKind, child: PlanNodeKind) {
  return (
    (parent === "OUTLINE" && (child === "VOLUME" || child === "CHAPTER"))
    || (parent === "VOLUME" && child === "CHAPTER")
    || (parent === "CHAPTER" && child === "SCENE")
  );
}

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
  const planningSections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const [kind, setKind] = useState<PlanNodeKind>("CHAPTER");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPlanningSectionId, setSelectedPlanningSectionId] = useState("positioning-genre");
  const [workDesignExpanded, setWorkDesignExpanded] = useState(true);
  const [expandedPlanningGroups, setExpandedPlanningGroups] = useState<Set<string>>(() => new Set(["creative-positioning"]));
  const [editTitle, setEditTitle] = useState("");
  const [moveParentId, setMoveParentId] = useState("");
  const [draft, setDraft] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);
  const [chapterTab, setChapterTab] = useState<ChapterWorkspaceTab>("editor");
  const [showArchived, setShowArchived] = useState(false);
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
      if (isRootKind(kind)) setKind("CHAPTER");
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function createStarterNode(starterKind: PlanNodeKind, starterTitle: string) {
    setError(null);
    try {
      const activeNodes = (nodes.data ?? []).filter((item) => !item.archived);
      const existingRoot = activeNodes.find((item) => item.parentId === null && item.kind === starterKind);
      if (starterKind !== "CHAPTER" && existingRoot) {
        setSelectedId(existingRoot.id);
        setEditTitle(existingRoot.title);
        setMoveParentId("");
        return;
      }

      let node;
      if (starterKind === "CHAPTER") {
        let outline = activeNodes.find((item) => item.parentId === null && item.kind === "OUTLINE");
        if (!outline) {
          outline = await createPlanNode({ kind: "OUTLINE", title: "故事大纲" });
        }
        node = await createPlanNode({ kind: "CHAPTER", title: starterTitle, parentId: outline.id });
      } else {
        node = await createPlanNode({ kind: starterKind, title: starterTitle });
      }
      setSelectedId(node.id);
      setEditTitle(node.title);
      setMoveParentId("");
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const selected = nodes.data?.find((node) => node.id === selectedId) ?? null;
  const activeNodes = (nodes.data ?? []).filter((node) => !node.archived);
  const visibleNodes = (nodes.data ?? []).filter((node) => !node.archived || showArchived);
  const rootNodeFor = (kind: PlanNodeKind) => activeNodes.find((node) => node.parentId === null && node.kind === kind);
  const primaryRootIds = new Set(rootDefinitions.map(({ kind }) => rootNodeFor(kind)?.id).filter((id): id is string => Boolean(id)));
  const unorganizedRoots = visibleNodes.filter((node) => node.parentId === null && !primaryRootIds.has(node.id));
  const parentCandidates = activeNodes.filter((node) => isValidParentKind(node.kind, kind));
  const canCreateAtRoot = isRootKind(kind) && !rootNodeFor(kind);
  const canAddNode = Boolean(title.trim()) && (canCreateAtRoot || Boolean(parentId));
  const moveCandidates = selected
    ? activeNodes.filter((node) => node.id !== selected.id && isValidParentKind(node.kind, selected.kind))
    : [];
  const canMoveToRoot = Boolean(selected && isRootKind(selected.kind) && !activeNodes.some((node) => node.id !== selected.id && node.parentId === null && node.kind === selected.kind));
  const workDesignNode = activeNodes.find((node) => node.kind === "WORK_DESIGN");
  const outlineNode = activeNodes.find((node) => node.kind === "OUTLINE");
  const chapterNodes = activeNodes.filter((node) => node.kind === "CHAPTER");
  const sceneCount = activeNodes.filter((node) => node.kind === "SCENE").length;
  const planningProgress = [workDesignNode, outlineNode, chapterNodes.length ? chapterNodes[0] : null, sceneCount ? activeNodes.find((node) => node.kind === "SCENE") : null].filter(Boolean).length;
  const nextPlanningNode = !workDesignNode ? null : !outlineNode ? workDesignNode : !chapterNodes.length ? outlineNode : chapterNodes[0];
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
      if (!node.archived) setSelectedId(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    if ((nodes.data ?? []).some((node) => node.parentId === selected.id && !node.archived)) {
      setError("请先删除或移动该节点下的子节点");
      return;
    }
    if (!window.confirm(`删除“${selected.title}”吗？删除后可通过“显示已删除节点”恢复。`)) return;
    await toggleArchived(selected);
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

  function renderNode(node: PlanNode, depth = 0): ReactNode {
    return (
      <div key={node.id}>
        <button type="button" className="plan-row" data-kind={node.kind.toLowerCase()} data-selected={selectedId === node.id && node.kind !== "WORK_DESIGN" || undefined} data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => { selectNode(node); if (node.kind === "WORK_DESIGN") setWorkDesignExpanded((value) => !value); }}>
          {node.kind === "WORK_DESIGN" ? workDesignExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}<span className="plan-kind">{kindLabels[node.kind]}</span><span className="plan-title">{node.title}</span>
        </button>
        {node.kind === "WORK_DESIGN" && !node.archived && workDesignExpanded ? <div className="plan-design-tree">{planningSectionGroups.map((group) => { const expanded = expandedPlanningGroups.has(group.id); return <div className="plan-design-group" key={group.id}><button type="button" className="plan-design-group-heading" aria-expanded={expanded} onClick={() => setExpandedPlanningGroups((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{group.label}</strong><span>{group.children.filter((item) => planningSections.data?.find((section) => section.id === item.id)?.content.trim()).length}/{group.children.length}</span></button>{expanded ? group.children.map((item) => { const completed = Boolean(planningSections.data?.find((section) => section.id === item.id)?.content.trim()); return <button type="button" className="plan-design-item" data-selected={selectedId === node.id && selectedPlanningSectionId === item.id || undefined} key={item.id} onClick={() => { selectNode(node); setSelectedPlanningSectionId(item.id); }}><span>{item.label}</span><small>{completed ? "完成" : "待填写"}</small></button>; }) : null}</div>; })}</div> : null}
        {visibleNodes.filter((child) => child.parentId === node.id).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <section className="project-workspace">
      <div className="workspace-heading">
        <p className="eyebrow">项目规划</p>
        <h1>把想法推进成可写的故事</h1>
        <p className="workspace-lede">规划只负责三件事：确定故事方向、拆出章节结构、为每个章节准备可执行的场景。知识库保存长期信息，正文区负责写作。</p>
      </div>

      {nodes.isPending ? <p className="plan-loading">正在加载规划…</p> : null}
      {nodes.isError ? <p className="project-error" role="alert">无法加载规划：{String(nodes.error)}</p> : null}
      {error ? <p className="project-error" role="alert">{error}</p> : null}

      {!nodes.isPending && !nodes.isError ? <div className="plan-layout">
      <div className="plan-tree" aria-label="规划树">
        <div className="section-heading"><div><h2>规划树</h2><p className="section-subtitle">点击节点，在右侧打开工作区</p></div><button type="button" className="icon-command plan-archive-toggle" onClick={() => setShowArchived((value) => !value)} aria-label={showArchived ? "隐藏已删除节点" : "显示已删除节点"} title={showArchived ? "隐藏已删除节点" : "显示已删除节点"}>{showArchived ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        <button type="button" className="plan-overview-row" data-selected={!selected || undefined} onClick={() => setSelectedId(null)}><BookOpen size={15} /><span>项目总览</span></button>
        <div className="plan-root-list">
          {rootDefinitions.map(({ kind: rootKind, label }) => {
            const root = rootNodeFor(rootKind);
            return (
              <section className="plan-root-section" key={rootKind}>
                <div className="plan-root-heading"><strong>{label}</strong><span>{root ? "已创建" : "预设"}</span></div>
                {root ? renderNode(root) : <button type="button" className="plan-preset-row" onClick={() => void createStarterNode(rootKind, label)}><Plus size={14} /><span>{label}</span><small>点击启用</small></button>}
              </section>
            );
          })}
          {unorganizedRoots.length ? (
            <section className="plan-root-section plan-root-unorganized">
              <div className="plan-root-heading"><strong>待整理</strong><span>{unorganizedRoots.length} 个节点</span></div>
              {unorganizedRoots.map((node) => renderNode(node))}
            </section>
          ) : null}
        </div>
      </div>

      {!selected ? <main className="planning-dashboard" aria-label="项目规划总览">
        <div className="planning-overview">
          <div className="planning-overview-heading"><div><span className="planning-kicker">当前项目状态</span><h2>{planningProgress < 4 ? `正在推进第 ${planningProgress + 1} 步` : "规划骨架已就绪"}</h2><p>{nextPlanningNode ? `建议继续：${kindLabels[nextPlanningNode.kind]}「${nextPlanningNode.title}」` : "先从作品设计开始，逐项确定小说要素。"}</p></div>{nextPlanningNode ? <button type="button" className="primary-action" onClick={() => selectNode(nextPlanningNode)}><ArrowRight size={15} />继续推进</button> : <button type="button" className="primary-action" onClick={() => void createStarterNode("WORK_DESIGN", "作品设计")}><Plus size={15} />启用作品设计</button>}</div>
          <div className="planning-stage-grid"><button type="button" className="planning-stage" data-active={planningProgress === 1 || undefined} onClick={() => workDesignNode ? selectNode(workDesignNode) : void createStarterNode("WORK_DESIGN", "作品设计")}><span className="planning-stage-index">01</span><div><strong>定方向</strong><small>主题、主角、世界规则</small></div><span className="planning-stage-count">{workDesignNode ? "已建立" : "预设"}</span></button><button type="button" className="planning-stage" data-active={planningProgress === 2 || undefined} onClick={() => outlineNode ? selectNode(outlineNode) : void createStarterNode("OUTLINE", "故事大纲")}><span className="planning-stage-index">02</span><div><strong>搭主线</strong><small>冲突、转折、故事节奏</small></div><span className="planning-stage-count">{outlineNode ? "已建立" : "预设"}</span></button><button type="button" className="planning-stage" data-active={planningProgress === 3 || undefined} onClick={() => chapterNodes[0] && selectNode(chapterNodes[0])}><span className="planning-stage-index">03</span><div><strong>拆章节</strong><small>{chapterNodes.length ? `${chapterNodes.length} 个章节` : "把主线拆成章节"}</small></div><span className="planning-stage-count">{chapterNodes.length ? "进行中" : "待开始"}</span></button><button type="button" className="planning-stage" data-active={planningProgress >= 4 || undefined} onClick={() => { const scene = activeNodes.find((node) => node.kind === "SCENE"); if (scene) selectNode(scene); }}><span className="planning-stage-index">04</span><div><strong>落到场景</strong><small>{sceneCount ? `${sceneCount} 个场景` : "明确每一场写什么"}</small></div><span className="planning-stage-count">{sceneCount ? "进行中" : "待开始"}</span></button></div>
          <div className="planning-overview-links"><span><UsersRound size={14} />人物、地点和规则放在知识库</span><span><FileCheck2 size={14} />章节完成后沉淀事实</span><span><Sparkles size={14} />AI 提供候选，由你定稿</span></div>
        </div>
        <div className="plan-create-row"><div className="plan-create-copy"><strong>添加结构节点</strong><span>分卷、章节和场景按归属加入规划树</span></div><select value={kind} onChange={(event) => { setKind(event.target.value as PlanNodeKind); setParentId(""); }} aria-label="节点类型">{Object.entries(kindLabels).map(([value, label]) => { const nodeKind = value as PlanNodeKind; const rootAlreadyExists = isRootKind(nodeKind) && Boolean(rootNodeFor(nodeKind)); return <option key={value} value={value} disabled={rootAlreadyExists}>{label}{rootAlreadyExists ? "（已预设）" : ""}</option>; })}</select><select value={parentId} onChange={(event) => setParentId(event.target.value)} aria-label="父节点"><option value="" disabled={!canCreateAtRoot}>{canCreateAtRoot ? "作为顶层节点" : "选择归属节点"}</option>{parentCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select><input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addNode(); }} placeholder="例如：第一卷·启程" aria-label="节点标题" /><button type="button" className="primary-action" onClick={() => void addNode()} disabled={!canAddNode}><Plus size={16} />新建节点</button></div>
      </main> : <main className={`plan-inspector${selected.kind === "WORK_DESIGN" ? " plan-inspector-work-design" : ""}`} aria-label="节点工作区">
        {selected.kind !== "WORK_DESIGN" ? <><div className="plan-inspector-heading"><div><span>当前节点</span><h2>{kindLabels[selected.kind]}</h2><p>修订 {selected.revision}</p></div><span className="inspector-node-id">{selected.title}</span></div>
        <div className="inspector-node-settings">
          <label className="inspector-name-field">节点名称<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="编辑节点标题" /></label>
          <div className="inspector-actions">
            <button type="button" className="primary-action" onClick={() => void saveSelected()} disabled={!editTitle.trim()}><Check size={15} />保存</button>
            {selected.archived ? <button type="button" className="secondary-action" onClick={() => void toggleArchived(selected)}><ArchiveRestore size={15} />恢复</button> : <button type="button" className="secondary-action destructive-action" onClick={() => void deleteSelected()}><Trash2 size={15} />删除</button>}
          </div>
          <div className="inspector-move-row"><label>归属<select value={moveParentId} onChange={(event) => setMoveParentId(event.target.value)} aria-label="移动到父节点"><option value="" disabled={!canMoveToRoot}>{canMoveToRoot ? "顶层" : "选择父节点"}</option>{moveCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select></label><button type="button" className="secondary-action" onClick={() => void moveSelected()} disabled={!canMoveToRoot && !moveParentId}>移动</button></div>
        </div></> : null}
        {selected.kind === "WORK_DESIGN" ? <StoryPlanningWorkbench selectedSectionId={selectedPlanningSectionId} /> : null}
        {selected.kind === "CHAPTER" ? <div className="chapter-editor">
          <div className="section-heading"><h2>章节工作区</h2><span>{manuscript.data ? "已有修订" : "尚未保存"}</span></div>
          <ChapterWorkspaceTabs value={chapterTab} onChange={setChapterTab} recoveryCount={recovery.data?.length ?? 0} />
          {chapterTab === "editor" ? <div className="chapter-tab-panel" id="chapter-panel-editor" role="tabpanel" aria-labelledby="chapter-tab-editor">
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
          {chapterTab === "ai" ? <div className="chapter-tab-panel" id="chapter-panel-ai" role="tabpanel" aria-labelledby="chapter-tab-ai"><AiWritingPanel chapterId={selected.id} chapterTitle={selected.title} chapterPlan={selected.title} draft={draft} editor={editor} /></div> : null}
          {chapterTab === "revisions" ? <div className="chapter-tab-panel" id="chapter-panel-revisions" role="tabpanel" aria-labelledby="chapter-tab-revisions">
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
          {chapterTab === "recovery" ? <div className="chapter-tab-panel" id="chapter-panel-recovery" role="tabpanel" aria-labelledby="chapter-tab-recovery">{recovery.data?.length ? <div className="recovery-banner"><span>发现 {recovery.data.length} 条可恢复草稿</span><button type="button" className="secondary-action" onClick={() => void recoverLatest()}>恢复最近草稿</button></div> : <div className="plan-empty">当前没有可恢复的草稿。</div>}</div> : null}
        </div> : null}
      </main>}
      </div> : null}
    </section>
  );
}
