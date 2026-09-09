import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ArrowRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, FileCheck2, Plus, Sparkles, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { cancelJob, clearRecoveryLogs, createPlanNode, currentManuscript, enqueuePlanningAiJob, errorMessage, listJobs, listManuscriptRevisions, listModelProfiles, listPlanningSections, listPlanNodes, listRecoveryLogs, mergeManuscript, movePlanNode, saveManuscriptChecked, savePlanningSection, saveRecoveryLog, updatePlanNodeChecked, type ManuscriptRevision, type MergeResult, type PlanNode, type PlanNodeKind, type PlanningSection } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";
import { ChapterWorkspaceTabs, type ChapterWorkspaceTab } from "./chapter-workspace-tabs";
import { essentialPlanningSectionIds, planningSectionGroups, StoryPlanningWorkbench } from "./story-planning-workbench";

const kindLabels: Record<PlanNodeKind, string> = {
  WORK_DESIGN: "作品设定",
  OUTLINE: "故事大纲",
  VOLUME_MANAGER: "分卷管理",
  VOLUME: "分卷",
  CHAPTER: "章节",
  SCENE: "场景",
};

const rootDefinitions: Array<{ kind: PlanNodeKind; label: string }> = [
  { kind: "WORK_DESIGN", label: "作品设定" },
  { kind: "OUTLINE", label: "故事大纲" },
  { kind: "VOLUME_MANAGER", label: "分卷管理" },
];

function isRootKind(kind: PlanNodeKind) {
  return kind === "WORK_DESIGN" || kind === "OUTLINE" || kind === "VOLUME_MANAGER";
}

function nodePlanId(nodeId: string) {
  return `plan-node:${nodeId}`;
}


function nodePlanPrompt(kind: PlanNodeKind) {
  if (kind === "OUTLINE") return "写清整部小说的主线因果：起点、关键转折、高潮和结局，不展开章节细节。";
  if (kind === "VOLUME") return "写清本分卷要完成的阶段任务、主要矛盾、人物变化和卷末转折。";
  if (kind === "CHAPTER") return "写清本章的目标、冲突、关键行动、情感变化和结尾钩子，作为正文写作执行卡。";
  return "写清本场景中谁要什么、发生什么阻碍、局面如何改变，以及场景结束时留下什么结果。";
}

function rootSectionLabel(kind: PlanNodeKind) {
  if (kind === "WORK_DESIGN") return "作品设定";
  if (kind === "VOLUME_MANAGER") return "分卷规划";
  return "故事结构";
}

function isValidParentKind(parent: PlanNodeKind, child: PlanNodeKind) {
  return (
    (parent === "VOLUME_MANAGER" && child === "VOLUME")
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

export function ProjectWorkspaceView(props: { mode?: "planning" | "writing" } = {}) {
  const workspaceMode = props.mode ?? "planning";
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const planningSections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 1200 });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const [kind, setKind] = useState<PlanNodeKind>("CHAPTER");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPlanningSectionId, setSelectedPlanningSectionId] = useState("seed-premise");
  const [workDesignExpanded, setWorkDesignExpanded] = useState(true);
  const [expandedPlanningGroups, setExpandedPlanningGroups] = useState<Set<string>>(() => new Set(["story-seed"]));
  const [editTitle, setEditTitle] = useState("");
  const [moveParentId, setMoveParentId] = useState("");
  const [draft, setDraft] = useState("");
  const [nodePlanDraft, setNodePlanDraft] = useState("");
  const [nodePlanTab, setNodePlanTab] = useState<"formal" | "pending">("formal");
  const [nodePlanPendingDraft, setNodePlanPendingDraft] = useState("");
  const [nodePlanGuidance, setNodePlanGuidance] = useState("");
  const [planningSectionDirty, setPlanningSectionDirty] = useState(false);
  const [savingNodePlan, setSavingNodePlan] = useState(false);
  const [generatingNodePlan, setGeneratingNodePlan] = useState(false);
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
        if (starterKind === "OUTLINE" && !activeNodes.some((item) => item.parentId === null && item.kind === "VOLUME_MANAGER")) {
          await createPlanNode({ kind: "VOLUME_MANAGER", title: "分卷管理" });
          await client.invalidateQueries({ queryKey: ["plan-nodes"] });
        }
        setSelectedId(existingRoot.id);
        setEditTitle(existingRoot.title);
        setMoveParentId("");
        return;
      }

      if (starterKind === "CHAPTER") {
        setError("章节需要手动挂到具体分卷下，请从项目总览添加章节。");
        return;
      }

      const node = await createPlanNode({ kind: starterKind, title: starterTitle });
      if (starterKind === "OUTLINE" && !activeNodes.some((item) => item.parentId === null && item.kind === "VOLUME_MANAGER")) {
        await createPlanNode({ kind: "VOLUME_MANAGER", title: "分卷管理" });
      }
      setSelectedId(node.id);
      setEditTitle(node.title);
      setMoveParentId("");
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function createSceneForChapter(chapterId: string) {
    setError(null);
    try {
      const activeNodes = (nodes.data ?? []).filter((item) => !item.archived);
      const chapter = activeNodes.find((item) => item.id === chapterId && item.kind === "CHAPTER");
      if (!chapter) return;
      const sceneCountForChapter = activeNodes.filter((item) => item.kind === "SCENE" && item.parentId === chapter.id).length;
      const scene = await createPlanNode({ kind: "SCENE", title: `场景${sceneCountForChapter + 1}`, parentId: chapter.id });
      setSelectedId(scene.id);
      setEditTitle(scene.title);
      setMoveParentId(chapter.id);
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
  const volumeNodes = activeNodes.filter((node) => node.kind === "VOLUME");
  const chapterNodes = activeNodes.filter((node) => node.kind === "CHAPTER");
  const completedPlanningSectionIds = new Set((planningSections.data ?? []).filter((section) => section.content.trim()).map((section) => section.id));
  const essentialCompletedCount = essentialPlanningSectionIds.filter((id) => completedPlanningSectionIds.has(id)).length;
  const nextEssentialSectionId = essentialPlanningSectionIds.find((id) => !completedPlanningSectionIds.has(id)) ?? essentialPlanningSectionIds[0];
  const coreSettingItems = essentialPlanningSectionIds.map((id) => ({ id, definition: planningSectionGroups.flatMap((group) => group.children).find((item) => item.id === id), section: planningSections.data?.find((item) => item.id === id) })).filter((item) => item.definition);
  const workDesignReady = essentialCompletedCount === essentialPlanningSectionIds.length;
  const outlinePlan = outlineNode ? planningSections.data?.find((section) => section.id === nodePlanId(outlineNode.id)) : undefined;
  const chaptersWithPlan = chapterNodes.filter((node) => planningSections.data?.find((section) => section.id === nodePlanId(node.id))?.content.trim()).length;
  const chapterWithoutPlan = chapterNodes.find((node) => !planningSections.data?.find((section) => section.id === nodePlanId(node.id))?.content.trim());
  const selectedStoredPlan = selected ? planningSections.data?.find((section) => section.id === nodePlanId(selected.id)) : undefined;
  const selectedVolume = selected?.kind === "CHAPTER" ? activeNodes.find((node) => node.id === selected.parentId && node.kind === "VOLUME") : undefined;
  const selectedVolumePlan = selectedVolume ? planningSections.data?.find((section) => section.id === nodePlanId(selectedVolume.id)) : undefined;
  const nodePlanJob = selected && selected.kind !== "WORK_DESIGN"
    ? (jobs.data ?? []).find((job) => {
      if (job.jobType !== "AI_PLANNING_GENERATE") return false;
      try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId === nodePlanId(selected.id); } catch { return false; }
    })
    : undefined;
  const chatProfile = profiles.data?.find((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const selectedChapterIndex = selected?.kind === "CHAPTER" ? chapterNodes.findIndex((node) => node.id === selected.id) : -1;
  const previousChapter = selectedChapterIndex > 0 ? chapterNodes[selectedChapterIndex - 1] : null;
  const nextChapter = selectedChapterIndex >= 0 && selectedChapterIndex < chapterNodes.length - 1 ? chapterNodes[selectedChapterIndex + 1] : null;
  const planningHeadline = !workDesignNode
    ? "从作品定位开始"
    : !workDesignReady
      ? `补齐 ${essentialPlanningSectionIds.length - essentialCompletedCount} 个核心设定`
      : !outlineNode
        ? "开放故事大纲"
        : !outlinePlan?.content.trim()
          ? "完成故事大纲"
          : !chapterNodes.length
            ? "开放分卷管理"
            : chapterWithoutPlan
              ? `补齐「${chapterWithoutPlan.title}」执行卡`
              : "规划已能支撑正文写作";
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
    const plan = selected ? planningSections.data?.find((section) => section.id === nodePlanId(selected.id)) : undefined;
    setNodePlanDraft(plan?.content ?? "");
    setNodePlanPendingDraft(plan?.pendingContent ?? "");
    setNodePlanTab(plan?.pendingContent?.trim() ? "pending" : "formal");
    setNodePlanGuidance("");
  }, [planningSections.data, selected?.id]);

  useEffect(() => {
    if (workspaceMode !== "writing" || selectedId || !chapterNodes.length) return;
    const requestedId = window.location.hash.slice(1);
    const requestedChapter = chapterNodes.find((node) => node.id === requestedId);
    if (requestedChapter) selectNode(requestedChapter);
  }, [chapterNodes, selectedId, workspaceMode]);

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

  async function saveNodePlan() {
    if (!selected || selected.kind === "WORK_DESIGN") return;
    const value = selected.kind === "OUTLINE" && nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft;
    if (!value.trim()) return;
    setSavingNodePlan(true);
    setError(null);
    try {
      const existing = planningSections.data?.find((section) => section.id === nodePlanId(selected.id));
      const section: PlanningSection = existing ?? { id: nodePlanId(selected.id), content: "", pendingContent: "", rationale: "", consequence: "", references: [], updatedAt: "" };
      await savePlanningSection({ ...section, ...(selected.kind === "OUTLINE" && nodePlanTab === "pending" ? { pendingContent: nodePlanPendingDraft.trim() } : { content: nodePlanDraft.trim() }) });
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingNodePlan(false);
    }
  }

  async function generateNodePlan() {
    if (!selected || selected.kind === "WORK_DESIGN" || !chatProfile) return;
    setGeneratingNodePlan(true);
    setError(null);
    try {
      const existing = (planningSections.data ?? []).filter((item) => item.content.trim()).map((item) => `${item.id}: ${item.content}`).join("\n");
      await enqueuePlanningAiJob({ profileId: chatProfile.id, mode: "GENERATE", sectionId: nodePlanId(selected.id), sectionTitle: selected.title, sectionPrompt: nodePlanPrompt(selected.kind), existingContext: existing, referenceContent: "", userGuidance: nodePlanGuidance.trim() || "请先给出可执行的候选方案，保留作者可修改的空间。", allowRewrite: false });
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGeneratingNodePlan(false); }
  }


  async function adoptNodePlan() {
    const pending = selected?.kind === "OUTLINE" ? nodePlanPendingDraft : selectedStoredPlan?.pendingContent ?? "";
    if (!selected || !pending.trim()) return;
    setSavingNodePlan(true);
    try {
      const section = selectedStoredPlan ?? { id: nodePlanId(selected.id), content: "", pendingContent: "", rationale: "", consequence: "", references: [], updatedAt: "" };
      await savePlanningSection({ ...section, content: pending.trim(), pendingContent: "" });
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSavingNodePlan(false); }
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
    if (selected?.kind === "CHAPTER" && draft.trim() && draft !== (manuscript.data?.documentJson ?? "") && !window.confirm("当前正文有未保存修改，确定切换吗？")) return false;
    if (selected?.kind === "WORK_DESIGN" && planningSectionDirty && selected.id !== node.id && !window.confirm("当前设定有未保存修改，确定切换吗？")) return false;
    if (selected && selected.kind !== "WORK_DESIGN" && selected.id !== node.id && nodePlanDraft !== (selectedStoredPlan?.content ?? "") && !window.confirm("当前规划有未保存修改，确定切换吗？")) return false;
    setSelectedId(node.id);
    setEditTitle(node.title);
    setMoveParentId(node.parentId ?? "");
    setChapterTab("editor");
    return true;
  }

  function selectPlanningSection(node: PlanNode, sectionId: string) {
    if (selected?.kind === "WORK_DESIGN" && planningSectionDirty && selectedPlanningSectionId !== sectionId && !window.confirm("当前设定有未保存修改，确定切换吗？")) return;
    if (selectNode(node)) setSelectedPlanningSectionId(sectionId);
  }

  async function continuePlanning() {
    if (!workDesignNode) {
      await createStarterNode("WORK_DESIGN", "作品设定");
      setSelectedPlanningSectionId(nextEssentialSectionId);
      return;
    }
    if (!workDesignReady) {
      if (selectNode(workDesignNode)) setSelectedPlanningSectionId(nextEssentialSectionId);
      return;
    }
    if (!outlineNode) {
      await createStarterNode("OUTLINE", "故事大纲");
      return;
    }
    if (!outlinePlan?.content.trim()) {
      selectNode(outlineNode);
      return;
    }
    if (!chapterNodes.length) {
      setSelectedId(null);
      return;
    }
    selectNode(chapterWithoutPlan ?? chapterNodes[0]);
  }

  async function moveSelected() {
    if (!selected) return;
    try { await movePlanNode({ id: selected.id, ...(moveParentId ? { parentId: moveParentId } : {}), expectedVersion: selected.revision }); await client.invalidateQueries({ queryKey: ["plan-nodes"] }); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  function renderNode(node: PlanNode, depth = 0): ReactNode {
    const isTopLevelPlanningNode = node.parentId === null && isRootKind(node.kind);
    return (
      <div key={node.id}>
        <button type="button" className="plan-row" data-kind={node.kind.toLowerCase()} data-selected={selectedId === node.id && node.kind !== "WORK_DESIGN" || undefined} data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => { selectNode(node); if (node.kind === "WORK_DESIGN") setWorkDesignExpanded((value) => !value); }}>
          {node.kind === "WORK_DESIGN" ? workDesignExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}{!isTopLevelPlanningNode ? <span className="plan-kind">{kindLabels[node.kind]}</span> : null}<span className="plan-title">{node.title}</span>
        </button>
        {node.kind === "WORK_DESIGN" && !node.archived && workDesignExpanded ? <div className="plan-design-tree">{planningSectionGroups.map((group) => { const expanded = expandedPlanningGroups.has(group.id); return <div className="plan-design-group" key={group.id}><button type="button" className="plan-design-group-heading" aria-expanded={expanded} onClick={() => setExpandedPlanningGroups((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{group.label}</strong><span>{group.children.filter((item) => planningSections.data?.find((section) => section.id === item.id)?.content.trim()).length}/{group.children.length}</span></button>{expanded ? group.children.map((item) => { const completed = Boolean(planningSections.data?.find((section) => section.id === item.id)?.content.trim()); const essential = essentialPlanningSectionIds.includes(item.id as (typeof essentialPlanningSectionIds)[number]); return <button type="button" className="plan-design-item" data-selected={selectedId === node.id && selectedPlanningSectionId === item.id || undefined} key={item.id} onClick={() => selectPlanningSection(node, item.id)}><span>{item.label}</span><small>{completed ? "完成" : essential ? "核心" : "待填写"}</small></button>; }) : null}</div>; })}</div> : null}
        {visibleNodes.filter((child) => child.parentId === node.id && (workspaceMode === "writing" || child.kind !== "SCENE")).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  function renderWritingNode(node: PlanNode, depth = 0): ReactNode {
    if (node.archived && !showArchived) return null;
    const isTopLevelPlanningNode = node.parentId === null && isRootKind(node.kind);
    return (
      <div key={node.id}>
        <button type="button" className="plan-row writing-tree-row" data-kind={node.kind.toLowerCase()} data-selected={selectedId === node.id || undefined} data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => selectNode(node)}>
          {!isTopLevelPlanningNode ? <span className="plan-kind">{kindLabels[node.kind]}</span> : null}<span className="plan-title">{node.title}</span>
        </button>
        {visibleNodes.filter((child) => child.parentId === node.id && (child.kind === "VOLUME" || child.kind === "CHAPTER" || child.kind === "SCENE")).map((child) => renderWritingNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <section className="project-workspace">
      <div className="workspace-heading">
        <p className="eyebrow">{workspaceMode === "writing" ? "正文工作区" : "项目规划"}</p>
        <h1>{workspaceMode === "writing" ? "把章节写成完整正文" : "把想法推进成可写的故事"}</h1>
        <p className="workspace-lede">{workspaceMode === "writing" ? "从左侧选择章节，查看章节执行卡，继续正文、AI 写作、修订和草稿恢复。章节结构与故事主线请回到规划页调整。" : "作品设定、故事大纲和分卷管理按顺序推进，章节和场景把计划变成可执行的写作任务，正文区负责完成文学表达。"}</p>
      </div>

      {nodes.isPending ? <p className="plan-loading">正在加载规划…</p> : null}
      {nodes.isError ? <p className="project-error" role="alert">无法加载规划：{String(nodes.error)}</p> : null}
      {error ? <p className="project-error" role="alert">{error}</p> : null}

      {!nodes.isPending && !nodes.isError ? <div className="plan-layout">
      <div className="plan-tree" aria-label="规划树">
        <div className="section-heading"><div><h2>{workspaceMode === "writing" ? "章节列表" : "规划树"}</h2><p className="section-subtitle">{workspaceMode === "writing" ? "选择章节进入正文、AI 写作和修订" : "作品设定与故事结构分开管理"}</p></div><button type="button" className="icon-command plan-archive-toggle" onClick={() => setShowArchived((value) => !value)} aria-label={showArchived ? "隐藏已删除节点" : "显示已删除节点"} title={showArchived ? "隐藏已删除节点" : "显示已删除节点"}>{showArchived ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        <button type="button" className="plan-overview-row" data-selected={!selected || undefined} onClick={() => setSelectedId(null)}><BookOpen size={15} /><span>{workspaceMode === "writing" ? "章节总览" : "项目总览"}</span></button>
        {workspaceMode === "writing" ? <div className="plan-root-list writing-tree-list">{visibleNodes.filter((node) => node.parentId === null && node.kind === "VOLUME_MANAGER").map((node) => renderWritingNode(node))}{!chapterNodes.length ? <p className="plan-empty">暂无章节，请先在规划页建立章节结构。</p> : null}</div> : <div className="plan-root-list">
          {rootDefinitions.map(({ kind: rootKind, label }) => {
            const root = rootNodeFor(rootKind);
            return (
              <section className="plan-root-section" key={rootKind}>
                <div className="plan-root-heading"><div><strong>{rootSectionLabel(rootKind)}</strong><small>{rootKind === "WORK_DESIGN" ? "确定作品原则与创作约束" : rootKind === "VOLUME_MANAGER" ? "管理分卷阶段与卷内章节归属" : "安排完整故事的事件因果与推进顺序"}</small></div><span>{root ? "已创建" : "预设"}</span></div>
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
        </div>}
      </div>

      {!selected ? <main className={`planning-dashboard${workspaceMode === "writing" ? " writing-mode" : ""}`} aria-label={workspaceMode === "writing" ? "正文工作区总览" : "项目规划总览"}>
          <div className="planning-overview">
          <div className="planning-overview-heading"><div><span className="planning-kicker">{workspaceMode === "writing" ? "正文工作区" : "建议下一步"}</span><h2>{workspaceMode === "writing" ? (chapterNodes.length ? "选择章节开始写作" : "还没有章节") : planningHeadline}</h2><p>{workspaceMode === "writing" ? (chapterNodes.length ? "章节执行卡、正文编辑和修订工具都集中在这里。" : "请先在规划页创建章节，再回到正文页开始写作。") : "按当前流程完成作品设定后，将依次开放故事大纲、分卷管理和章节规划。"}</p></div>{workspaceMode === "writing" ? chapterNodes[0] ? <button type="button" className="primary-action" onClick={() => selectNode(chapterNodes[0])}><ArrowRight size={15} />打开第1章</button> : <a className="primary-action" href="/planning"><ArrowRight size={15} />前往规划页</a> : <button type="button" className="primary-action" onClick={() => void continuePlanning()}><ArrowRight size={15} />继续下一步</button>}</div>
          <div className="planning-stage-grid"><button type="button" className="planning-stage" data-state={workDesignReady ? "done" : workDesignNode ? "active" : "idle"} onClick={() => { if (workDesignNode) { if (selectNode(workDesignNode)) setSelectedPlanningSectionId(nextEssentialSectionId); } else void createStarterNode("WORK_DESIGN", "作品设定"); }}><span className="planning-stage-index">01</span><div><strong>作品设定</strong><small>完成后开放故事大纲</small></div><span className="planning-stage-count">{workDesignReady ? "已完成" : "进行中"}</span></button><button type="button" className="planning-stage" data-state={outlinePlan?.content.trim() ? "done" : outlineNode ? workDesignReady ? "active" : "idle" : "idle"} onClick={() => workDesignReady && (outlineNode ? selectNode(outlineNode) : void createStarterNode("OUTLINE", "故事大纲"))}><span className="planning-stage-index">02</span><div><strong>故事大纲</strong><small>{workDesignReady ? "开放主线规划" : "完成作品设定后开放"}</small></div><span className="planning-stage-count">{!workDesignReady ? "未开放" : outlinePlan?.content.trim() ? "已完成" : "进行中"}</span></button><button type="button" className="planning-stage" data-state={chapterNodes.length && chaptersWithPlan === chapterNodes.length ? "done" : chapterNodes.length ? "active" : "idle"} onClick={() => chapterNodes[0] ? selectNode(chapterWithoutPlan ?? chapterNodes[0]) : setSelectedId(null)}><span className="planning-stage-index">03</span><div><strong>分卷与章节</strong><small>{outlinePlan?.content.trim() ? "开放分卷管理和章节规划" : "完成故事大纲后开放"}</small></div><span className="planning-stage-count">{outlinePlan?.content.trim() ? (chapterNodes.length ? `${chaptersWithPlan}/${chapterNodes.length}` : "已开放") : "未开放"}</span></button></div>
          <div className="planning-overview-links"><span><UsersRound size={14} />人物、地点和规则放在知识库</span><span><FileCheck2 size={14} />章节完成后沉淀事实</span><span><Sparkles size={14} />AI 提供候选，由你定稿</span><span>{volumeNodes.length ? `已规划 ${volumeNodes.length} 卷` : "建议先拆分分卷"}</span></div>
        </div>
      </main> : <main className={`plan-inspector${selected.kind === "WORK_DESIGN" ? " plan-inspector-work-design" : ""}`} aria-label="节点工作区">
        {selected.kind !== "WORK_DESIGN" ? <><div className="plan-inspector-heading"><div><span>{selected.kind === "OUTLINE" ? "故事结构 / 主线总览" : "当前节点"}</span><h2>{kindLabels[selected.kind]}</h2><p>{selected.kind === "OUTLINE" ? "从主线到分卷，再到章节执行卡" : `修订 ${selected.revision}`}</p></div><span className="inspector-node-id">{selected.title}</span></div>
        {selected.kind !== "OUTLINE" && selected.kind !== "VOLUME_MANAGER" ? <div className="inspector-node-settings">
          <label className="inspector-name-field">节点名称<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="编辑节点标题" /></label>
          <div className="inspector-actions">
            <button type="button" className="primary-action" onClick={() => void saveSelected()} disabled={!editTitle.trim()}><Check size={15} />保存</button>
            {selected.archived ? <button type="button" className="secondary-action" onClick={() => void toggleArchived(selected)}><ArchiveRestore size={15} />恢复</button> : <button type="button" className="secondary-action destructive-action" onClick={() => void deleteSelected()}><Trash2 size={15} />删除</button>}
          </div>
          <div className="inspector-move-row"><label>归属<select value={moveParentId} onChange={(event) => setMoveParentId(event.target.value)} aria-label="移动到父节点"><option value="" disabled={!canMoveToRoot}>{canMoveToRoot ? "顶层" : "选择父节点"}</option>{moveCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select></label><button type="button" className="secondary-action" onClick={() => void moveSelected()} disabled={!canMoveToRoot && !moveParentId}>移动</button></div>
        </div> : null}{selected.kind === "VOLUME_MANAGER" ? <div className="volume-manager-panel"><div className="section-heading"><div><h3>分卷管理</h3><span>分卷是主线确定后的阶段容器，章节必须挂在具体分卷下。</span></div><small>{volumeNodes.length ? `${volumeNodes.length} 个分卷` : "尚未创建"}</small></div><div className="outline-structure-strip"><div><strong>{volumeNodes.length}</strong><span>个分卷</span></div><div><strong>{chapterNodes.length}</strong><span>个章节</span></div><div><strong>{chaptersWithPlan}</strong><span>张执行卡</span></div><small>分卷用于控制阶段目标，章节负责落地执行</small></div><div className="outline-volume-list"><div className="outline-volume-heading"><strong>分卷规划</strong><span>{!outlinePlan?.content.trim() ? "完成故事大纲后开放" : volumeNodes.length ? "点击进入单卷细化" : "请在项目总览添加分卷"}</span></div>{!outlinePlan?.content.trim() ? <div className="outline-volume-empty"><strong>分卷规划暂未开启</strong><span>完成故事大纲后开放分卷管理。</span><button type="button" className="secondary-action" onClick={() => outlineNode && selectNode(outlineNode)}>返回故事结构</button></div> : volumeNodes.length ? volumeNodes.map((volume, index) => { const plan = planningSections.data?.find((item) => item.id === nodePlanId(volume.id)); const volumeChapters = chapterNodes.filter((chapter) => chapter.parentId === volume.id); return <button type="button" className="outline-volume-row" key={volume.id} onClick={() => selectNode(volume)}><span className="outline-volume-index">{String(index + 1).padStart(2, "0")}</span><span className="outline-volume-copy"><strong>{volume.title}</strong><small>{volumeChapters.length ? `${volumeChapters.length} 个章节` : "尚未拆章节"} · {plan?.content.trim() ? "已写分卷规划" : "待补分卷规划"}</small></span><ChevronRight size={15} /></button>; }) : <div className="outline-volume-empty"><strong>还没有分卷</strong><span>请在项目总览的“添加结构节点”中创建分卷。</span></div>}</div></div> : null}{selected.kind === "OUTLINE" && !workDesignReady ? <div className="node-plan-locked"><strong>故事大纲尚未开放</strong><span>还需补齐 {essentialPlanningSectionIds.length - essentialCompletedCount} 个核心设定，完成后开放故事大纲。</span><button type="button" className="secondary-action" onClick={() => { if (workDesignNode) { selectNode(workDesignNode); setSelectedPlanningSectionId(nextEssentialSectionId); } else setSelectedId(null); }}>{workDesignNode ? "去作品设定" : "回到项目总览"}</button></div> : null}{(selected.kind !== "CHAPTER" && selected.kind !== "VOLUME_MANAGER" && !(selected.kind === "OUTLINE" && !workDesignReady)) || (selected.kind === "CHAPTER" && workspaceMode === "planning") ? <div className={`node-plan-editor${selected.kind === "OUTLINE" ? " outline-plan-editor" : ""}`}><div className="section-heading"><div><h3>{selected.kind === "OUTLINE" ? "主线规划" : selected.kind === "VOLUME" ? "分卷规划" : selected.kind === "CHAPTER" ? "章节执行卡" : "场景执行卡"}</h3><span>{nodePlanPrompt(selected.kind)}</span></div><small>{nodePlanDraft.trim() ? "已填写" : "待填写"}</small></div>
          {selected.kind === "CHAPTER" && selectedVolume ? <div className="chapter-plan-context"><span>来自分卷：{selectedVolume.title}</span><p>{selectedVolumePlan?.content?.trim() || "该分卷还没有正式规划，请先补充分卷目标和阶段转折。"}</p></div> : null}
          {selected.kind === "OUTLINE" ? <div className="outline-context-panel"><div className="outline-context-heading"><div><span>上游依据</span><strong>作品设定</strong></div><small>{coreSettingItems.filter((item) => item.section?.content.trim()).length}/{coreSettingItems.length} 个核心设定</small></div>{coreSettingItems.some((item) => item.section?.content.trim()) ? <div className="outline-context-summary">{coreSettingItems.filter((item) => item.section?.content.trim()).map(({ definition, section }) => <span key={definition?.id}><b>{definition?.label}</b>{section?.content.trim()?.slice(0, 34)}</span>)}</div> : <div className="outline-context-empty"><strong>还没有可供主线使用的作品设定</strong><span>先完成故事前提、主角、对抗力量、赌注和结局，AI 才能生成贴合你作品的主线。</span></div>}{!workDesignReady ? <button type="button" className="secondary-action" onClick={() => { if (workDesignNode) { selectNode(workDesignNode); setSelectedPlanningSectionId(nextEssentialSectionId); } else setSelectedId(null); }}>{workDesignNode ? "先补齐作品设定" : "回到项目总览创建作品设定"}</button> : null}</div> : null}
          {selected.kind === "OUTLINE" ? <div className="outline-next-step"><div className="outline-next-copy"><span className="outline-next-kicker">现在先做这一步</span><strong>{nodePlanDraft.trim() ? "检查主线，再拆分第一卷" : "基于作品设定生成故事主线"}</strong><small>{nodePlanDraft.trim() ? "主线只需要写起点、关键转折、高潮和结局，不用展开章节细节。" : "AI 会参考人物目标、主题命题、核心冲突、赌注和结局落点，先生成一版可修改的主线候选。"}</small></div><div className="outline-next-actions"><button type="button" className="primary-action" onClick={() => nodePlanDraft.trim() ? setSelectedId(null) : void generateNodePlan()} disabled={!nodePlanDraft.trim() && (!chatProfile || generatingNodePlan || !workDesignReady)}>{nodePlanDraft.trim() ? "回到项目总览拆分分卷" : "基于设定生成主线"}</button>{nodePlanDraft.trim() ? <button type="button" className="secondary-action" onClick={() => setNodePlanDraft("")}>重新开始</button> : null}</div></div> : null}
          {(selected.kind === "OUTLINE" || selected.kind === "VOLUME") ? <><label className="node-plan-guidance"><span>给 AI 的补充意见（可选）</span><textarea rows={2} value={nodePlanGuidance} onChange={(event) => setNodePlanGuidance(event.target.value)} placeholder={selected.kind === "OUTLINE" ? "例如：更偏悬疑，保留开放式结局，不要新增超自然设定" : "例如：这一卷重点写关系决裂，卷末必须留下身份真相"} /></label><div className="node-plan-ai-bar"><div><Sparkles size={15} /><span><strong>AI 共创</strong><small>结合上游设定生成候选，确认后才会写入正式规划</small></span></div><button type="button" className="secondary-action" onClick={() => void generateNodePlan()} disabled={!chatProfile || generatingNodePlan || (selected.kind === "OUTLINE" && !workDesignReady) || (selected.kind === "VOLUME" && !outlinePlan?.content.trim()) || Boolean(nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING")}><Sparkles size={14} />{nodePlanJob?.status === "RUNNING" ? "推导中…" : "生成候选"}</button></div></> : null}
          {nodePlanJob && (nodePlanJob.status === "QUEUED" || nodePlanJob.status === "RUNNING") ? <div className="node-plan-job"><span>AI 正在梳理结构，完成后候选会出现在待定区</span><div><i style={{ width: `${nodePlanJob.progress}%` }} /></div><button type="button" onClick={() => void cancelJob(nodePlanJob.id)}>取消</button></div> : null}
          {selected.kind === "VOLUME" && !outlinePlan?.content.trim() ? <div className="node-plan-locked"><strong>分卷规划尚未开启</strong><span>先在故事大纲中确认正式主线，系统才会开放分卷目标与卷末转折规划。</span><button type="button" className="secondary-action" onClick={() => outlineNode && selectNode(outlineNode)}>返回故事大纲</button></div> : <>{selected.kind === "OUTLINE" ? <div className="node-plan-tabs" role="tablist"><button type="button" role="tab" aria-selected={nodePlanTab === "formal"} data-active={nodePlanTab === "formal" || undefined} onClick={() => setNodePlanTab("formal")}>正式主线<small>{nodePlanDraft.trim() ? "已确认" : "未确认"}</small></button><button type="button" role="tab" aria-selected={nodePlanTab === "pending"} data-active={nodePlanTab === "pending" || undefined} onClick={() => setNodePlanTab("pending")}>待定区<small>{nodePlanPendingDraft.trim() ? "有候选" : "暂无候选"}</small></button></div> : null}<textarea rows={selected.kind === "OUTLINE" ? 12 : 8} value={selected.kind === "OUTLINE" && nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft} onChange={(event) => selected.kind === "OUTLINE" && nodePlanTab === "pending" ? setNodePlanPendingDraft(event.target.value) : setNodePlanDraft(event.target.value)} placeholder={nodePlanPrompt(selected.kind)} />{selected.kind === "OUTLINE" && nodePlanTab === "pending" ? <div className="node-plan-actions"><button type="button" className="secondary-action" onClick={() => void saveNodePlan()} disabled={savingNodePlan || !nodePlanPendingDraft.trim()}>保存待定候选</button><button type="button" className="primary-action" onClick={() => void adoptNodePlan()} disabled={savingNodePlan || !nodePlanPendingDraft.trim()}><Check size={15} />采用为正式主线</button></div> : null}{selectedStoredPlan?.pendingContent?.trim() && selected.kind !== "OUTLINE" ? <div className="node-plan-candidate"><div><strong>待定候选</strong><small>AI 已生成，可编辑后采用</small></div><p>{selectedStoredPlan.pendingContent}</p><button type="button" className="secondary-action" onClick={() => { setNodePlanDraft(selectedStoredPlan.pendingContent); }}>载入编辑</button><button type="button" className="primary-action" onClick={() => void adoptNodePlan()} disabled={savingNodePlan}>采用候选</button></div> : null}<button type="button" className="primary-action" onClick={() => void saveNodePlan()} disabled={savingNodePlan || !(selected.kind === "OUTLINE" && nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft).trim()}><Check size={15} />{savingNodePlan ? "保存中…" : selected.kind === "OUTLINE" && nodePlanTab === "pending" ? "保存待定候选" : "保存规划"}</button></>}</div> : null}</> : null}
        {selected.kind === "VOLUME_MANAGER" && workspaceMode === "planning" && outlinePlan?.content.trim() ? <div className="plan-create-row volume-manager-create-row"><div className="plan-create-copy"><strong>添加结构节点</strong><span>在分卷管理中创建分卷、章节和场景</span></div><select value={kind} onChange={(event) => { setKind(event.target.value as PlanNodeKind); setParentId(""); }} aria-label="节点类型">{Object.entries(kindLabels).filter(([value]) => value !== "VOLUME_MANAGER" && value !== "OUTLINE" && value !== "WORK_DESIGN").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={parentId} onChange={(event) => setParentId(event.target.value)} aria-label="父节点"><option value="" disabled>选择归属节点</option>{parentCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select><input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addNode(); }} placeholder="例如：第一卷·启程" aria-label="节点标题" /><button type="button" className="primary-action" onClick={() => void addNode()} disabled={!canAddNode}><Plus size={16} />新建节点</button></div> : null}
        {selected.kind === "WORK_DESIGN" ? <StoryPlanningWorkbench selectedSectionId={selectedPlanningSectionId} onSelectSection={setSelectedPlanningSectionId} onDirtyChange={setPlanningSectionDirty} /> : null}
        {selected.kind === "CHAPTER" && workspaceMode === "planning" ? <div className="planning-redirect-panel"><BookOpen size={18} /><div><strong>执行卡明确后，进入正文完成本章</strong><span>正文、AI 写作、修订与恢复统一集中到正文工作区，并会沿用当前章节执行卡。</span></div><a href={`/writing#${selected.id}`}>写这一章</a></div> : null}
        {selected.kind === "CHAPTER" && workspaceMode === "writing" ? <div className="chapter-editor">
          <div className="section-heading"><div><h2>章节工作区</h2><span>第 {selectedChapterIndex + 1} / {chapterNodes.length} 章 · {manuscript.data ? "已有修订" : "尚未保存"}</span></div><div className="chapter-heading-actions"><button type="button" className="icon-command" onClick={() => previousChapter && selectNode(previousChapter)} disabled={!previousChapter} aria-label="上一章" title="上一章"><ChevronLeft size={16} /></button><button type="button" className="icon-command" onClick={() => nextChapter && selectNode(nextChapter)} disabled={!nextChapter} aria-label="下一章" title="下一章"><ChevronRight size={16} /></button><button type="button" className="secondary-action" onClick={() => void createSceneForChapter(selected.id)}><Plus size={14} />按需拆分场景</button></div></div>
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
          {chapterTab === "ai" ? <div className="chapter-tab-panel" id="chapter-panel-ai" role="tabpanel" aria-labelledby="chapter-tab-ai"><AiWritingPanel chapterId={selected.id} chapterTitle={selected.title} chapterPlan={nodePlanDraft} draft={draft} editor={editor} /></div> : null}
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
