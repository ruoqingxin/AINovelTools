import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ArrowRight, BookOpen, Check, ChevronRight, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { cancelJob, createPlanNode, enqueuePlanningAiJob, errorMessage, getAuditFlowSettings, getCurrentProject, listModelProfiles, listPlanningSections, listPlanNodes, movePlanNode, savePlanningSection, updatePlanNodeChecked, type PlanNode, type PlanNodeKind, type PlanningSection } from "../lib/tauri-client";
import { useJobs } from "../lib/jobs-query";
import { AiModelNote } from "./ai-model-note";
import { ChapterFocusHeader } from "./chapter-focus-header";
import { ChapterCreationWorkspace } from "./chapter-creation-workspace";
import { useChapterManuscript } from "./use-chapter-manuscript";
import { usePlanningDraft } from "./use-planning-draft";
import { buildWorkspaceNodeIndex } from "./project-workspace-index";
import { PlanningDashboard } from "./planning-dashboard";
import { ProjectPlanTree } from "./project-plan-tree";
import { essentialPlanningSectionIds, planningSectionGroups, StoryPlanningWorkbench } from "./story-planning-workbench";
import { isPlanningSectionSettled } from "../lib/writing-readiness";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

import {
  buildVolumePlanTargetGuidance,
  isRootKind,
  isValidParentKind,
  kindLabels,
  lastWritingChapterKey,
  nodePlanId,
  nodePlanPrompt,
  parseChapterPlanCandidates,
  parseVolumePlanCandidates,
  resolveDefaultWritingChapter,
  rootDefinitions,
} from "./project-workspace-utils";

const planningDefinitionsById = new Map(planningSectionGroups.flatMap((group) => group.children).map((item) => [item.id, item]));

export function ProjectWorkspaceView(props: { mode?: "planning" | "chapters" | "writing" } = {}) {
  const workspaceMode = props.mode ?? "planning";
  const isChapterMode = workspaceMode === "chapters" || workspaceMode === "writing";
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const currentProject = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const planningSections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const jobs = useJobs();
  const auditFlow = useQuery({ queryKey: ["audit-flow-settings"], queryFn: getAuditFlowSettings });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const [kind, setKind] = useState<PlanNodeKind>("CHAPTER");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPlanningSectionId, setSelectedPlanningSectionId] = useState("seed-premise");
  const [workDesignExpanded, setWorkDesignExpanded] = useState(true);
  const [expandedPlanningGroups, setExpandedPlanningGroups] = useState<Set<string>>(() => new Set(["story-seed"]));
  const [editTitle, setEditTitle] = useState("");
  const [moveParentId, setMoveParentId] = useState("");
  const [nodePlanTab, setNodePlanTab] = useState<"formal" | "pending">("formal");
  const [nodePlanGuidance, setNodePlanGuidance] = useState("");
  const [volumePlanTargets, setVolumePlanTargets] = useState({ wordCount: "", volumeCount: "", chapterCount: "" });
  const [showVolumePlanning, setShowVolumePlanning] = useState(false);
  const [chapterSplitVolumeId, setChapterSplitVolumeId] = useState("");
  const [chapterSplitBatchCount, setChapterSplitBatchCount] = useState("20");
  const [chapterSplitGuidance, setChapterSplitGuidance] = useState("");
  const [planningSectionDirty, setPlanningSectionDirty] = useState(false);
  const [savingNodePlan, setSavingNodePlan] = useState(false);
  const [generatingNodePlan, setGeneratingNodePlan] = useState(false);
  const [generatingChapterSplit, setGeneratingChapterSplit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [chapterListCollapsed, setChapterListCollapsed] = useState(false);
  const [chapterSearch, setChapterSearch] = useState("");

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
        setError("请在分卷管理的“添加结构节点”中创建章节。");
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

  function beginChapterSplit(volumeId?: string) {
    const firstVolumeWithoutChapters = volumeNodes.find((volume) => !chapterNodes.some((chapter) => chapter.parentId === volume.id));
    const targetVolumeId = volumeId || firstVolumeWithoutChapters?.id || volumeNodes[0]?.id || "";
    setKind("CHAPTER");
    setParentId(targetVolumeId);
    setChapterSplitVolumeId(targetVolumeId);
    setTitle("");
    window.requestAnimationFrame(() => document.getElementById("volume-chapter-splitter")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  const nodeIndex = useMemo(() => buildWorkspaceNodeIndex(nodes.data ?? []), [nodes.data]);
  const sectionsById = useMemo(() => new Map((planningSections.data ?? []).map((section) => [section.id, section])), [planningSections.data]);
  const selected = selectedId ? nodeIndex.nodesById.get(selectedId) ?? null : null;
  const selectedQueryPlan = selected ? sectionsById.get(nodePlanId(selected.id)) : undefined;
  const nodeDraft = usePlanningDraft(selected ? nodePlanId(selected.id) : "", selectedQueryPlan, planningSections.data !== undefined);
  const selectedStoredPlan = nodeDraft.baseline;
  const nodePlanDraft = nodeDraft.form.content;
  const nodePlanPendingDraft = nodeDraft.form.pendingContent;
  const setNodePlanDraft = (content: string) => nodeDraft.setForm((current) => ({ ...current, content }));
  const setNodePlanPendingDraft = (pendingContent: string) => nodeDraft.setForm((current) => ({ ...current, pendingContent }));
  const chapterManuscript = useChapterManuscript({
    chapterId: selected?.kind === "CHAPTER" ? selected.id : undefined,
    projectId: currentProject.data?.projectId,
    mode: workspaceMode,
    onError: setError,
    initialTab: isChapterMode
      ? new URLSearchParams(window.location.search).get("tab") === "extraction" ? "extraction" : "candidate"
      : "manuscript",
  });
  const { manuscript, chapterDirty, savingDraft, setManuscriptTab } = chapterManuscript;
  const activeNodes = nodeIndex.activeNodes;
  const visibleNodes = showArchived ? nodes.data ?? [] : activeNodes;
  const rootNodeFor = (kind: PlanNodeKind) => nodeIndex.rootsByKind.get(kind);
  const primaryRootIds = new Set(rootDefinitions.map(({ kind }) => rootNodeFor(kind)?.id).filter((id): id is string => Boolean(id)));
  const unorganizedRoots = visibleNodes.filter((node) => node.parentId === null && !primaryRootIds.has(node.id));
  const parentCandidates = activeNodes.filter((node) => isValidParentKind(node.kind, kind));
  const canCreateAtRoot = isRootKind(kind) && !rootNodeFor(kind);
  const canAddNode = Boolean(title.trim()) && (canCreateAtRoot || Boolean(parentId));
  const moveCandidates = selected
    ? activeNodes.filter((node) => node.id !== selected.id && isValidParentKind(node.kind, selected.kind))
    : [];
  const canMoveToRoot = Boolean(selected && isRootKind(selected.kind) && !activeNodes.some((node) => node.id !== selected.id && node.parentId === null && node.kind === selected.kind));
  const workDesignNode = nodeIndex.nodesByKind.WORK_DESIGN[0];
  const outlineNode = nodeIndex.nodesByKind.OUTLINE[0];
  const volumeManagerNode = nodeIndex.nodesByKind.VOLUME_MANAGER[0];
  const volumeNodes = nodeIndex.nodesByKind.VOLUME;
  const chapterNodes = nodeIndex.nodesByKind.CHAPTER;
  const completedPlanningSectionIds = useMemo(() => new Set((planningSections.data ?? []).filter(isPlanningSectionSettled).map((section) => section.id)), [planningSections.data]);
  const essentialCompletedCount = essentialPlanningSectionIds.filter((id) => completedPlanningSectionIds.has(id)).length;
  const nextEssentialSectionId = essentialPlanningSectionIds.find((id) => !completedPlanningSectionIds.has(id)) ?? essentialPlanningSectionIds[0];
  const coreSettingItems = essentialPlanningSectionIds.map((id) => ({ id, definition: planningDefinitionsById.get(id), section: sectionsById.get(id) })).filter((item) => item.definition);
  const workDesignReady = essentialCompletedCount === essentialPlanningSectionIds.length;
  const outlinePlan = outlineNode ? sectionsById.get(nodePlanId(outlineNode.id)) : undefined;
  const chaptersWithPlan = chapterNodes.filter((node) => isPlanningSectionSettled(sectionsById.get(nodePlanId(node.id)))).length;
  const chapterWithoutPlan = chapterNodes.find((node) => !isPlanningSectionSettled(sectionsById.get(nodePlanId(node.id))));
  const volumesWithoutChapters = useMemo(() => volumeNodes.filter((volume) => !nodeIndex.chaptersByVolume.has(volume.id)), [nodeIndex, volumeNodes]);
  const volumePlanReady = volumeNodes.length > 0;
  const creatableNodeKinds = Object.entries(kindLabels).filter(([value]) => value !== "VOLUME_MANAGER" && value !== "OUTLINE" && value !== "WORK_DESIGN" && (!volumePlanReady || showVolumePlanning || value === "CHAPTER"));
  const chapterSplitVolume = volumeNodes.find((volume) => volume.id === chapterSplitVolumeId) ?? volumeNodes[0];
  const chapterSplitSectionId = chapterSplitVolume ? `chapter-split-${chapterSplitVolume.id}` : "";
  const chapterSplitStoredPlan = sectionsById.get(chapterSplitSectionId);
  const splitDraft = usePlanningDraft(chapterSplitSectionId, chapterSplitStoredPlan, planningSections.data !== undefined);
  const chapterSplitPendingDraft = splitDraft.form.pendingContent;
  const setChapterSplitPendingDraft = (pendingContent: string) => splitDraft.setForm((current) => ({ ...current, pendingContent }));
  const chapterSplitCandidates = useMemo(() => parseChapterPlanCandidates(chapterSplitPendingDraft), [chapterSplitPendingDraft]);
  const chapterSplitExistingCount = chapterSplitVolume ? nodeIndex.chaptersByVolume.get(chapterSplitVolume.id)?.length ?? 0 : 0;
  const chapterSplitTotalTarget = Number.parseInt(volumePlanTargets.chapterCount, 10);
  const chapterSplitVolumeIndex = chapterSplitVolume ? volumeNodes.findIndex((volume) => volume.id === chapterSplitVolume.id) : -1;
  const chapterSplitTargetCount = volumeNodes.length && Number.isFinite(chapterSplitTotalTarget) && chapterSplitTotalTarget > 0
    ? Math.floor(chapterSplitTotalTarget / volumeNodes.length) + (chapterSplitVolumeIndex < chapterSplitTotalTarget % volumeNodes.length ? 1 : 0)
    : 0;
  const chapterSplitBatchSize = Math.min(50, Math.max(1, Number.parseInt(chapterSplitBatchCount, 10) || 20));
  const chapterSplitJob = chapterSplitSectionId
    ? (jobs.data ?? []).find((job) => {
      if (job.jobType !== "AI_PLANNING_GENERATE") return false;
      try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId === chapterSplitSectionId; } catch { return false; }
    })
    : undefined;
  const chapterSplitBusy = generatingChapterSplit || Boolean(chapterSplitJob?.status === "QUEUED" || chapterSplitJob?.status === "RUNNING");
  const showNodePlanAiBar = selected?.kind === "VOLUME" || (selected?.kind === "OUTLINE" && Boolean(nodePlanDraft.trim()));
  const parent = selected?.parentId ? nodeIndex.nodesById.get(selected.parentId) : undefined;
  const selectedVolume = parent?.kind === "VOLUME" && !parent.archived ? parent : undefined;
  const selectedVolumePlan = selectedVolume ? sectionsById.get(nodePlanId(selectedVolume.id)) : undefined;
  const nodePlanJob = selected && selected.kind !== "WORK_DESIGN"
    ? (jobs.data ?? []).find((job) => {
      if (job.jobType !== "AI_PLANNING_GENERATE") return false;
      try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId === nodePlanId(selected.id); } catch { return false; }
    })
    : undefined;
  const volumeManagerCandidates = useMemo(() => selected?.kind === "VOLUME_MANAGER" ? parseVolumePlanCandidates(nodePlanPendingDraft) : [], [selected?.kind, nodePlanPendingDraft]);
  const outlineProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "outline");
  const volumeProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "volumePlanning");
  const chapterSplitProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "chapterSplit");
  const outlinePreference = resolveTaskPreference(aiPreferences.data, "outline");
  const volumePreference = resolveTaskPreference(aiPreferences.data, "volumePlanning");
  const chapterSplitPreference = resolveTaskPreference(aiPreferences.data, "chapterSplit");
  const nodeTaskProfile = selected?.kind === "OUTLINE"
    ? outlineProfile
    : selected?.kind === "VOLUME" || selected?.kind === "VOLUME_MANAGER"
      ? volumeProfile
      : undefined;
  const nodeTaskPreference = selected?.kind === "OUTLINE" ? outlinePreference : volumePreference;
  const selectedChapterIndex = selected?.kind === "CHAPTER" ? chapterNodes.findIndex((node) => node.id === selected.id) : -1;
  const previousChapter = selectedChapterIndex > 0 ? chapterNodes[selectedChapterIndex - 1] : null;
  const nextChapter = selectedChapterIndex >= 0 && selectedChapterIndex < chapterNodes.length - 1 ? chapterNodes[selectedChapterIndex + 1] : null;
  const chapterJumpOptions = chapterNodes.filter((node) => node.title.toLocaleLowerCase().includes(chapterSearch.trim().toLocaleLowerCase()));
  const planningHeadline = !workDesignNode
    ? "从作品定位开始"
    : !workDesignReady
      ? `明确 ${essentialPlanningSectionIds.length - essentialCompletedCount} 个核心设定`
      : !outlineNode
        ? "开放故事大纲"
        : !outlinePlan?.content.trim()
          ? "完成故事大纲"
          : !volumeNodes.length
            ? "规划分卷结构"
            : !chapterNodes.length
              ? "开始拆分章节"
            : chapterWithoutPlan
              ? `补充「${chapterWithoutPlan.title}」执行卡`
              : "规划已能支撑正文写作";
  const nodePlanDirty = Boolean(selected && selected.kind !== "WORK_DESIGN" && nodeDraft.dirty);
  const titleDirty = Boolean(selected && editTitle !== selected.title);
  const [candidatePanelsPending, setCandidatePanelsPending] = useState(false);
  const workspaceDirty = nodePlanDirty || splitDraft.dirty || titleDirty || planningSectionDirty || savingNodePlan || candidatePanelsPending;
  const unsavedMessage = candidatePanelsPending
      ? "当前候选面板有未提交修改或正在处理的操作。"
      : nodePlanDirty
      ? "当前规划有未保存修改。"
      : titleDirty
        ? "当前结构节点名称有未保存修改。"
        : "当前作品设定有未保存修改。";
  useUnsavedChangesGuard(workspaceDirty, unsavedMessage);

  useEffect(() => {
    setNodePlanTab("formal");
    setNodePlanGuidance("");
  }, [selected?.id]);

  useEffect(() => {
    if (nodeDraft.baseline.pendingContent.trim()) setNodePlanTab("pending");
  }, [selected?.id, nodeDraft.baseline.pendingContent]);

  useEffect(() => {
    setShowVolumePlanning(false);
  }, [selected?.id]);

  useEffect(() => {
    if (!volumePlanReady) {
      setChapterSplitVolumeId("");
      return;
    }
    if (!volumeNodes.some((volume) => volume.id === chapterSplitVolumeId)) {
      setChapterSplitVolumeId(volumesWithoutChapters[0]?.id ?? volumeNodes[0]?.id ?? "");
    }
  }, [chapterSplitVolumeId, volumeNodes, volumePlanReady, volumesWithoutChapters]);

  useEffect(() => {
    if (chapterSplitJob?.status !== "SUCCEEDED") return;
    void client.invalidateQueries({ queryKey: ["planning-sections"] });
  }, [chapterSplitJob?.id, chapterSplitJob?.status, client]);

  useEffect(() => {
    if (!isChapterMode || selectedId || !chapterNodes.length) return;
    const requestedId = window.location.hash.slice(1);
    if (workspaceMode === "chapters") {
      const requestedChapter = chapterNodes.find((node) => node.id === requestedId);
      if (requestedChapter) selectNode(requestedChapter);
      return;
    }
    if (currentProject.isPending) return;
    let rememberedId = "";
    try {
      rememberedId = window.localStorage.getItem(lastWritingChapterKey(currentProject.data?.projectId ?? "current")) ?? "";
    } catch {
      // Storage may be unavailable in restricted webviews; the first chapter remains a safe fallback.
    }
    const defaultChapter = resolveDefaultWritingChapter(chapterNodes, requestedId, rememberedId);
    if (defaultChapter) selectNode(defaultChapter);
  }, [chapterNodes, currentProject.data?.projectId, currentProject.isPending, isChapterMode, selectedId, workspaceMode]);

  useEffect(() => {
    if (workspaceMode !== "writing" || selected?.kind !== "CHAPTER" || currentProject.isPending) return;
    try {
      window.localStorage.setItem(lastWritingChapterKey(currentProject.data?.projectId ?? "current"), selected.id);
    } catch {
      // Remembering the chapter is a convenience and must not block editing.
    }
  }, [currentProject.data?.projectId, currentProject.isPending, selected?.id, selected?.kind, workspaceMode]);

  useEffect(() => {
    if (workspaceMode !== "planning" || selectedId) return;
    const requestedId = window.location.hash.slice(1);
    if (!requestedId) return;
    const requestedSection = planningSectionGroups.flatMap((group) => group.children).find((item) => item.id === requestedId);
    if (requestedSection && workDesignNode) {
      if (selectNode(workDesignNode)) setSelectedPlanningSectionId(requestedId);
      return;
    }
    const requestedNode = activeNodes.find((node) => node.id === requestedId);
    if (requestedNode) selectNode(requestedNode);
  }, [activeNodes, selectedId, workspaceMode, workDesignNode]);

  useEffect(() => {
    if (nodePlanJob?.status !== "SUCCEEDED") return;
    void client.invalidateQueries({ queryKey: ["planning-sections"] });
  }, [client, nodePlanJob?.id, nodePlanJob?.status]);

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

  async function saveNodePlan() {
    if (!selected || selected.kind === "WORK_DESIGN") return;
    const value = selected.kind === "OUTLINE" && nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft;
    if (!value.trim()) return;
    const snapshot = nodeDraft.beginSave();
    if (!snapshot) return;
    setSavingNodePlan(true);
    setError(null);
    try {
      const saved = await savePlanningSection({ ...snapshot.form, version: snapshot.baseline.version, ...(selected.kind === "OUTLINE" && nodePlanTab === "pending" ? { pendingContent: snapshot.form.pendingContent.trim(), storyState: "AI_SUGGESTED" as const } : { content: snapshot.form.content.trim(), storyState: "CONFIRMED" as const }) });
      nodeDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
    } catch (cause) {
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    } finally {
      nodeDraft.finishSave(snapshot);
      setSavingNodePlan(false);
    }
  }

  async function generateNodePlan() {
    if (!selected || selected.kind === "WORK_DESIGN" || !nodeTaskProfile) return;
    setGeneratingNodePlan(true);
    setError(null);
    try {
      const existing = (planningSections.data ?? []).filter((item) => item.content.trim()).map((item) => `${item.id}: ${item.content}`).join("\n");
      const targetGuidance = selected.kind === "VOLUME_MANAGER" ? buildVolumePlanTargetGuidance(volumePlanTargets) : "";
      const userGuidance = [nodePlanGuidance.trim(), targetGuidance].filter(Boolean).join("\n");
      await enqueuePlanningAiJob({ profileId: nodeTaskProfile.id, mode: "GENERATE", sectionId: nodePlanId(selected.id), sectionTitle: selected.title, sectionPrompt: nodePlanPrompt(selected.kind), existingContext: existing, referenceContent: "", userGuidance: userGuidance || "请先给出可执行的候选方案，保留作者可修改的空间。", allowRewrite: false, taskKey: selected.kind === "OUTLINE" ? "outline" : "volumePlanning", temperature: nodeTaskPreference.temperature ?? undefined, maxOutputTokens: nodeTaskPreference.maxOutputTokens ?? undefined });
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGeneratingNodePlan(false); }
  }

  async function generateChapterSplit() {
    if (!chapterSplitVolume || !chapterSplitProfile || chapterSplitBusy) return;
    setGeneratingChapterSplit(true);
    setError(null);
    try {
      const volumePlan = sectionsById.get(nodePlanId(chapterSplitVolume.id))?.content.trim() ?? "";
      const existing = (planningSections.data ?? []).filter((item) => item.content.trim()).map((item) => `${item.id}: ${item.content}`).join("\n");
      const startChapterNumber = chapterNodes.length + 1;
      const targetGuidance = [
        chapterSplitTargetCount ? `本卷预计共 ${chapterSplitTargetCount} 章` : "",
        `当前本卷已拆 ${chapterSplitExistingCount} 章`,
        `本次最多生成 ${chapterSplitBatchSize} 章，从第 ${startChapterNumber} 章开始连续编号`,
      ].filter(Boolean).join("；");
      const userGuidance = [
        chapterSplitGuidance.trim(),
        targetGuidance,
        volumePlan ? `本卷正式规划：${volumePlan}` : "",
      ].filter(Boolean).join("\n");
      const sectionPrompt = `根据本分卷的正式规划，将其拆成可独立写作的章节。本次最多生成 ${chapterSplitBatchSize} 章，从第 ${startChapterNumber} 章开始连续编号。每章必须独占一行，只输出“第X章·标题｜本章目标｜关键冲突｜结尾钩子”，严禁输出解释、标题、编号、空行，也严禁把多章写在同一行。若本卷尚未拆完，本次只输出下一批章节，不要总结全卷。`;
      await enqueuePlanningAiJob({
        profileId: chapterSplitProfile.id,
        mode: "GENERATE",
        sectionId: chapterSplitSectionId,
        sectionTitle: `${chapterSplitVolume.title}·章节拆分`,
        sectionPrompt,
        existingContext: existing,
        referenceContent: "",
        userGuidance: userGuidance || "请按剧情阶段拆分，避免重复章节目标。",
        allowRewrite: false,
        taskKey: "chapterSplit",
        temperature: chapterSplitPreference.temperature ?? undefined,
        maxOutputTokens: chapterSplitPreference.maxOutputTokens ?? undefined,
      });
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setGeneratingChapterSplit(false);
    }
  }

  async function adoptChapterSplitPlan() {
    if (!chapterSplitVolume) return;
    const candidates = parseChapterPlanCandidates(chapterSplitPendingDraft);
    if (!candidates.length) {
      setError("没有识别到可创建的章节，请按“第X章·标题｜本章目标｜关键冲突｜结尾钩子”的格式检查候选。");
      return;
    }
    const volumeChapterTitles = new Set(chapterNodes.filter((chapter) => chapter.parentId === chapterSplitVolume.id).map((chapter) => chapter.title));
    const newCandidates = candidates.filter((candidate) => !volumeChapterTitles.has(candidate.title));
    if (!newCandidates.length) {
      setError("候选中的章节均已存在，没有需要创建的新章节。");
      return;
    }
    if (chapterSplitExistingCount && !window.confirm(`本卷已有 ${chapterSplitExistingCount} 个章节，继续将追加 ${newCandidates.length} 个新章节。确定继续吗？`)) return;
    const snapshot = splitDraft.beginSave();
    if (!snapshot) return;
    setSavingNodePlan(true);
    setError(null);
    try {
      for (const candidate of newCandidates) {
        const node = await createPlanNode({ parentId: chapterSplitVolume.id, kind: "CHAPTER", title: candidate.title });
        if (candidate.content.trim()) {
          await savePlanningSection({
            id: nodePlanId(node.id),
            content: candidate.content.trim(),
            pendingContent: "",
            storyState: "CONFIRMED",
            rationale: "",
            consequence: "",
            references: [],
            updatedAt: "",
          });
        }
      }
      const saved = await savePlanningSection({
        ...snapshot.baseline,
        pendingContent: "",
        storyState: snapshot.baseline.content.trim() ? snapshot.baseline.storyState : "UNSET",
      });
      splitDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["plan-nodes"] }),
        client.invalidateQueries({ queryKey: ["planning-sections"] }),
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      splitDraft.finishSave(snapshot);
      setSavingNodePlan(false);
    }
  }


  async function adoptNodePlan() {
    const pending = nodePlanPendingDraft;
    if (!selected || !pending.trim()) return;
    const snapshot = nodeDraft.beginSave();
    if (!snapshot) return;
    setSavingNodePlan(true);
    try {
      const saved = await savePlanningSection({ ...snapshot.form, version: snapshot.baseline.version, content: pending.trim(), pendingContent: "", storyState: "CONFIRMED" });
      nodeDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
    } catch (cause) {
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    }
    finally {
      nodeDraft.finishSave(snapshot);
      setSavingNodePlan(false);
    }
  }

  function cacheSavedSection(saved: PlanningSection) {
    client.setQueryData<PlanningSection[]>(["planning-sections"], (items) =>
      [...(items ?? []).filter((item) => item.id !== saved.id), saved]);
  }

  async function adoptVolumeManagerPlan() {
    if (!selected || selected.kind !== "VOLUME_MANAGER") return;
    const candidates = parseVolumePlanCandidates(nodePlanPendingDraft);
    if (!candidates.length) {
      setError("没有识别到可创建的分卷，请按“第X卷·标题｜阶段目标｜主要矛盾｜卷末转折”的格式填写。");
      return;
    }
    const existingTitles = new Set(volumeNodes.map((node) => node.title));
    const newCandidates = candidates.filter((candidate) => !existingTitles.has(candidate.title));
    if (!newCandidates.length) {
      setError("候选中的分卷均已存在，没有需要创建的新分卷。");
      return;
    }
    if (volumeNodes.length && !window.confirm(`当前已有 ${volumeNodes.length} 个分卷，继续将追加 ${newCandidates.length} 个新分卷。确定继续吗？`)) return;
    const snapshot = nodeDraft.beginSave();
    if (!snapshot) return;
    setSavingNodePlan(true);
    setError(null);
    try {
      let firstCreatedVolumeId = "";
      for (const candidate of newCandidates) {
        const node = await createPlanNode({ parentId: selected.id, kind: "VOLUME", title: candidate.title });
        if (!firstCreatedVolumeId) firstCreatedVolumeId = node.id;
        if (candidate.content.trim()) {
          await savePlanningSection({
            id: nodePlanId(node.id),
            content: candidate.content.trim(),
            pendingContent: "",
            storyState: "CONFIRMED",
            rationale: "",
            consequence: "",
            references: [],
            updatedAt: "",
          });
        }
      }
      const saved = await savePlanningSection({ ...snapshot.form, version: snapshot.baseline.version, content: snapshot.form.pendingContent.trim(), pendingContent: "", storyState: "CONFIRMED" });
      nodeDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      setKind("CHAPTER");
      setParentId(firstCreatedVolumeId || volumeNodes[0]?.id || "");
      setChapterSplitVolumeId(firstCreatedVolumeId || volumeNodes[0]?.id || "");
      setShowVolumePlanning(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["plan-nodes"] }),
        client.invalidateQueries({ queryKey: ["planning-sections"] }),
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      nodeDraft.finishSave(snapshot);
      setSavingNodePlan(false);
    }
  }

  function selectNode(node: PlanNode) {
    if (selected?.id === node.id) return true;
    if (savingDraft || savingNodePlan) {
      setError("内容正在保存，请稍后切换章节。");
      return false;
    }
    if ((chapterManuscript.draftNeedsPersistence || workspaceDirty) && !window.confirm(`${chapterManuscript.draftNeedsPersistence ? "当前草稿尚未保存在本地。" : unsavedMessage}确定切换吗？`)) return false;
    setSelectedId(node.id);
    setEditTitle(node.title);
    setMoveParentId(node.parentId ?? "");
    setManuscriptTab("candidate");
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
      if (volumeManagerNode) selectNode(volumeManagerNode);
      else await createStarterNode("VOLUME_MANAGER", "分卷管理");
      return;
    }
    selectNode(chapterWithoutPlan ?? chapterNodes[0]);
  }

  async function moveSelected() {
    if (!selected) return;
    try { await movePlanNode({ id: selected.id, ...(moveParentId ? { parentId: moveParentId } : {}), expectedVersion: selected.revision }); await client.invalidateQueries({ queryKey: ["plan-nodes"] }); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  return (
    <section className="project-workspace">
      <div className="workspace-heading">
        {isChapterMode ? null : <p className="eyebrow">项目规划</p>}
        <h1>{isChapterMode ? "创作" : "把想法推进成可写的故事"}</h1>
        {!isChapterMode ? <p className="workspace-lede">作品设定、故事大纲和分卷规划</p> : null}
      </div>

      {nodes.isPending ? <p className="plan-loading">正在加载规划…</p> : null}
      {nodes.isError ? <p className="project-error" role="alert">无法加载规划：{errorMessage(nodes.error)}</p> : null}
      {error ? <p className="project-error" role="alert">{error}</p> : null}

      {!nodes.isPending && !nodes.isError ? <div className={`plan-layout${isChapterMode ? " chapter-mode-layout" : ""}${workspaceMode === "writing" ? " writing-focus-layout" : ""}${chapterListCollapsed && workspaceMode === "chapters" ? " chapter-list-collapsed" : ""}`}>
      {workspaceMode !== "writing" ? <ProjectPlanTree
        chapterMode={isChapterMode}
        chapterListCollapsed={chapterListCollapsed}
        chapterNodes={chapterNodes}
        expandedPlanningGroups={expandedPlanningGroups}
        onCollapseChapterList={() => setChapterListCollapsed(true)}
        onCreateStarterNode={createStarterNode}
        onExpandChapterList={() => setChapterListCollapsed(false)}
        onSelectNode={selectNode}
        onSelectOverview={() => {
          if (savingDraft || savingNodePlan) { setError("内容正在保存，请稍后返回总览。"); return; }
          if ((chapterManuscript.draftNeedsPersistence || workspaceDirty) && !window.confirm("当前内容有未保存修改，确定返回总览吗？")) return;
          setSelectedId(null);
        }}
        onSelectPlanningSection={selectPlanningSection}
        onToggleArchived={() => setShowArchived((value) => !value)}
        onTogglePlanningGroup={(groupId) => setExpandedPlanningGroups((current) => {
          const next = new Set(current);
          if (next.has(groupId)) next.delete(groupId);
          else next.add(groupId);
          return next;
        })}
        onToggleWorkDesign={() => setWorkDesignExpanded((value) => !value)}
        planningSections={planningSections.data ?? []}
        rootNodeFor={rootNodeFor}
        selectedId={selectedId}
        selectedPlanningSectionId={selectedPlanningSectionId}
        showArchived={showArchived}
        unorganizedRoots={unorganizedRoots}
        visibleNodes={visibleNodes}
        workDesignExpanded={workDesignExpanded}
      /> : null}

      {!selected ? <PlanningDashboard
        chapterNodes={chapterNodes}
        chapterWithoutPlan={chapterWithoutPlan}
        chaptersWithPlan={chaptersWithPlan}
        isChapterMode={isChapterMode}
        onContinuePlanning={continuePlanning}
        onOpenChapterStructure={() => {
          if (!outlinePlan?.content.trim()) return;
          if (chapterNodes[0]) selectNode(chapterWithoutPlan ?? chapterNodes[0]);
          else if (volumeManagerNode) selectNode(volumeManagerNode);
          else void createStarterNode("VOLUME_MANAGER", "分卷管理");
        }}
        onOpenFirstChapter={() => chapterNodes[0] && selectNode(chapterNodes[0])}
        onOpenOutline={() => {
          if (!workDesignReady) return;
          if (outlineNode) selectNode(outlineNode);
          else void createStarterNode("OUTLINE", "故事大纲");
        }}
        onOpenWorkDesign={() => {
          if (workDesignNode) {
            if (selectNode(workDesignNode)) setSelectedPlanningSectionId(nextEssentialSectionId);
          } else void createStarterNode("WORK_DESIGN", "作品设定");
        }}
        outlineNode={outlineNode}
        outlinePlan={outlinePlan}
        planningHeadline={planningHeadline}
        volumeNodes={volumeNodes}
        volumePlanReady={volumePlanReady}
        workDesignNode={workDesignNode}
        workDesignReady={workDesignReady}
        workspaceMode={workspaceMode}
      /> : <main className={`plan-inspector${selected.kind === "WORK_DESIGN" ? " plan-inspector-work-design" : ""}${selected.kind === "CHAPTER" && isChapterMode ? " chapter-focus-inspector" : ""}`} aria-label="节点工作区">
        {selected?.kind === "CHAPTER" && isChapterMode ? <ChapterFocusHeader
          canMoveToRoot={canMoveToRoot}
          chapterDirty={chapterDirty}
          chapterJumpOptions={chapterJumpOptions}
          chapterNodes={chapterNodes}
          chapterSearch={chapterSearch}
          editTitle={editTitle}
          manuscriptReady={Boolean(manuscript.data)}
          moveCandidates={moveCandidates}
          moveParentId={moveParentId}
          nextChapter={nextChapter}
          onDelete={deleteSelected}
          onEditTitleChange={setEditTitle}
          onMove={moveSelected}
          onMoveParentChange={setMoveParentId}
          onCreateScene={createSceneForChapter}
          onSave={saveSelected}
          onSearchChange={setChapterSearch}
          onSelectNode={selectNode}
          onToggleArchived={toggleArchived}
          previousChapter={previousChapter}
          savingDraft={savingDraft}
          selected={selected}
          selectedChapterIndex={selectedChapterIndex}
          selectedVolume={selectedVolume}
          workspaceMode={workspaceMode}
        /> : null}
        {selected.kind !== "WORK_DESIGN" ? <>{!(selected.kind === "CHAPTER" && isChapterMode) ? <div className="plan-inspector-heading"><div><span>{selected.kind === "OUTLINE" ? "故事结构 / 主线总览" : "当前节点"}</span><h2>{kindLabels[selected.kind]}</h2><p>{selected.kind === "OUTLINE" ? "从主线到分卷，再到章节执行卡" : `修订 ${selected.revision}`}</p></div><span className="inspector-node-id">{selected.title}</span></div> : null}
        {selected.kind !== "OUTLINE" && selected.kind !== "VOLUME_MANAGER" && !(selected.kind === "CHAPTER" && isChapterMode) ? <div className="inspector-node-settings">
          <label className="inspector-name-field">节点名称<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="编辑节点标题" /></label>
          <div className="inspector-actions">
            <button type="button" className="primary-action" onClick={() => void saveSelected()} disabled={!editTitle.trim()}><Check size={15} />保存</button>
            {selected.archived ? <button type="button" className="secondary-action" onClick={() => void toggleArchived(selected)}><ArchiveRestore size={15} />恢复</button> : <button type="button" className="secondary-action destructive-action" onClick={() => void deleteSelected()}><Trash2 size={15} />删除</button>}
          </div>
          <div className="inspector-move-row"><label>归属<select value={moveParentId} onChange={(event) => setMoveParentId(event.target.value)} aria-label="移动到父节点"><option value="" disabled={!canMoveToRoot}>{canMoveToRoot ? "顶层" : "选择父节点"}</option>{moveCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select></label><button type="button" className="secondary-action" onClick={() => void moveSelected()} disabled={!canMoveToRoot && !moveParentId}>移动</button></div>
        </div> : null}{selected.kind === "VOLUME_MANAGER" ? <div className="volume-manager-panel"><div className="section-heading"><div><h3>{volumePlanReady ? "拆分章节" : "分卷管理"}</h3><span>{volumePlanReady ? "分卷结构已确认，接下来为每卷建立章节并补齐执行卡。" : "分卷是主线确定后的阶段容器，章节必须挂在具体分卷下。"}</span></div><small>{volumePlanReady ? `${volumeNodes.length} 卷 · ${chapterNodes.length} 章` : "尚未创建分卷"}</small></div><div className="outline-structure-strip"><div><strong>{volumeNodes.length}</strong><span>个分卷</span></div><div><strong>{chapterNodes.length}</strong><span>个章节</span></div><div><strong>{chaptersWithPlan}</strong><span>张执行卡</span></div><small>{volumePlanReady ? `${volumesWithoutChapters.length} 个分卷尚未拆章节` : "分卷用于控制阶段目标，章节负责落地执行"}</small></div>{outlinePlan?.content.trim() && (!volumePlanReady || showVolumePlanning) ? <div className="volume-manager-ai-panel">{volumePlanReady ? <div className="volume-planning-notice"><span>分卷已建立，可继续生成并追加分卷。</span><button type="button" className="secondary-action" onClick={() => { setShowVolumePlanning(false); setKind("CHAPTER"); }}>返回拆章节</button></div> : null}<div className="volume-manager-targets"><label><span>本书字数（万字）</span><input type="number" min="1" inputMode="numeric" value={volumePlanTargets.wordCount} onChange={(event) => setVolumePlanTargets((current) => ({ ...current, wordCount: event.target.value }))} placeholder="例如 120" /></label><label><span>分卷数（卷）</span><input type="number" min="1" inputMode="numeric" value={volumePlanTargets.volumeCount} onChange={(event) => setVolumePlanTargets((current) => ({ ...current, volumeCount: event.target.value }))} placeholder="例如 4" /></label><label><span>章节数（章）</span><input type="number" min="1" inputMode="numeric" value={volumePlanTargets.chapterCount} onChange={(event) => setVolumePlanTargets((current) => ({ ...current, chapterCount: event.target.value }))} placeholder="例如 400" /></label></div><AiModelNote taskLabel="分卷规划" taskKey="volumePlanning" profile={volumeProfile} preference={volumePreference} /><label className="node-plan-guidance"><span>给 AI 的补充意见（可选）</span><textarea rows={2} value={nodePlanGuidance} onChange={(event) => setNodePlanGuidance(event.target.value)} placeholder="例如：第一卷尽快进入冲突，卷末必须有不可逆变化" /></label><div className="node-plan-ai-bar"><div><Sparkles size={15} /><span><strong>{volumePlanReady ? "AI 补充分卷" : "AI 生成分卷"}</strong><small>根据作品设定、正式主线与规模目标生成分卷结构候选</small></span></div><button type="button" className="secondary-action" onClick={() => void generateNodePlan()} disabled={!volumeProfile?.hasSecret || generatingNodePlan || Boolean(nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING")}><Sparkles size={14} />{nodePlanJob?.status === "RUNNING" ? "生成中…" : volumePlanReady ? "生成补充候选" : "生成分卷候选"}</button></div>{nodePlanJob && (nodePlanJob.status === "QUEUED" || nodePlanJob.status === "RUNNING") ? <div className="node-plan-job"><span>AI 正在规划分卷结构，完成后候选会出现在这里</span><div><i style={{ width: `${nodePlanJob.progress}%` }} /></div><button type="button" onClick={() => void cancelJob(nodePlanJob.id)}>取消</button></div> : null}{nodePlanPendingDraft.trim() ? <div className="node-plan-candidate volume-manager-candidate"><div><strong>AI 分卷候选</strong><small>{volumeManagerCandidates.length ? `已识别 ${volumeManagerCandidates.length} 个分卷，可修改后采用` : "未识别到分卷，请检查格式"}</small></div><textarea rows={6} value={nodePlanPendingDraft} onChange={(event) => setNodePlanPendingDraft(event.target.value)} aria-label="分卷候选" /><div className="node-plan-actions"><button type="button" className="primary-action" onClick={() => void adoptVolumeManagerPlan()} disabled={savingNodePlan || !volumeManagerCandidates.length}><Check size={14} />采用并创建 {volumeManagerCandidates.length || 0} 个分卷</button></div></div> : null}</div> : null}{outlinePlan?.content.trim() && volumePlanReady && !showVolumePlanning ? <div className="volume-split-next-step"><div className="outline-next-copy"><span className="outline-next-kicker">分卷规划已完成</span><strong>下一步：拆章节</strong><small>{volumesWithoutChapters.length ? `还有 ${volumesWithoutChapters.length} 个分卷尚未拆章节。先选择分卷，再添加章节标题。` : `已为所有分卷建立章节，共 ${chapterNodes.length} 章，可继续补充或进入执行卡规划。`}</small></div><div className="outline-next-actions"><button type="button" className="primary-action" onClick={() => beginChapterSplit()}><ArrowRight size={15} />继续拆章节</button><button type="button" className="secondary-action" onClick={() => setShowVolumePlanning(true)}>重新调整分卷</button></div></div> : null}{outlinePlan?.content.trim() && volumePlanReady && !showVolumePlanning ? <section className="chapter-split-ai-panel"><div className="chapter-split-ai-heading"><div><span className="outline-next-kicker">AI 拆章节</span><h3>按分卷生成章节候选</h3><p>AI 根据本卷规划和全书章节目标生成候选，确认后才创建章节。</p></div><small>{chapterSplitTargetCount ? `本卷目标约 ${chapterSplitTargetCount} 章` : "未设置本卷章节目标"}</small></div><div className="chapter-split-controls"><label><span>目标分卷</span><select value={chapterSplitVolume?.id ?? ""} onChange={(event) => { setChapterSplitVolumeId(event.target.value); setChapterSplitGuidance(""); }} aria-label="拆章节目标分卷">{volumeNodes.map((volume, index) => <option key={volume.id} value={volume.id}>{String(index + 1).padStart(2, "0")} · {volume.title}</option>)}</select></label><label><span>本批章节数</span><input type="number" min="1" max="50" inputMode="numeric" value={chapterSplitBatchCount} onChange={(event) => setChapterSplitBatchCount(event.target.value)} aria-label="本批章节数" /></label><div className="chapter-split-progress"><span>本卷进度</span><strong>{chapterSplitExistingCount}{chapterSplitTargetCount ? ` / ${chapterSplitTargetCount}` : ""} 章</strong><small>下一批从第 {chapterNodes.length + 1} 章开始</small></div></div><AiModelNote taskLabel="章节拆分" taskKey="chapterSplit" profile={chapterSplitProfile} preference={chapterSplitPreference} runMultiplier={Number(chapterSplitBatchCount) || 1} /><label className="node-plan-guidance"><span>本章拆分补充要求（可选）</span><textarea rows={2} value={chapterSplitGuidance} onChange={(event) => setChapterSplitGuidance(event.target.value)} placeholder="例如：每章只推进一个主要事件，前 5 章节奏要快，保留卷末三章做连续反转" /></label><div className="node-plan-ai-bar"><div><Sparkles size={15} /><span><strong>AI 拆分本卷</strong><small>分批生成，避免一次输出过多章节被截断</small></span></div><button type="button" className="secondary-action" onClick={() => void generateChapterSplit()} disabled={!chapterSplitProfile?.hasSecret || chapterSplitBusy || !chapterSplitSectionId}><Sparkles size={14} />{chapterSplitBusy ? "生成中…" : "生成章节候选"}</button></div>{chapterSplitJob && (chapterSplitJob.status === "QUEUED" || chapterSplitJob.status === "RUNNING") ? <div className="node-plan-job"><span>AI 正在拆分「{chapterSplitVolume?.title}」，完成后候选会出现在这里</span><div><i style={{ width: `${chapterSplitJob.progress}%` }} /></div><button type="button" onClick={() => void cancelJob(chapterSplitJob.id)}>取消</button></div> : null}{chapterSplitPendingDraft.trim() ? <div className="node-plan-candidate chapter-split-candidate"><div><strong>章节拆分候选</strong><small>{chapterSplitCandidates.length ? `已识别 ${chapterSplitCandidates.length} 章，可修改后采用` : "未识别到章节，请检查格式"}</small></div><textarea rows={8} value={chapterSplitPendingDraft} onChange={(event) => setChapterSplitPendingDraft(event.target.value)} aria-label="章节拆分候选" /><div className="node-plan-actions"><button type="button" className="secondary-action" onClick={() => setChapterSplitPendingDraft("")}>清空候选</button><button type="button" className="primary-action" onClick={() => void adoptChapterSplitPlan()} disabled={savingNodePlan || !chapterSplitCandidates.length}><Check size={14} />采用并创建 {chapterSplitCandidates.length || 0} 章</button></div></div> : null}</section> : null}<div className="outline-volume-list"><div className="outline-volume-heading"><strong>{volumePlanReady ? "各卷章节拆分进度" : "分卷规划"}</strong><span>{!outlinePlan?.content.trim() ? "完成故事大纲后开放" : volumePlanReady ? "点击分卷查看规划；在下方添加章节" : "请使用下方“添加结构节点”创建分卷"}</span></div>{!outlinePlan?.content.trim() ? <div className="outline-volume-empty"><strong>分卷规划暂未开启</strong><span>完成故事大纲后开放分卷管理。</span><button type="button" className="secondary-action" onClick={() => outlineNode && selectNode(outlineNode)}>返回故事结构</button></div> : volumeNodes.length ? volumeNodes.map((volume, index) => { const plan = sectionsById.get(nodePlanId(volume.id)); const volumeChapters = chapterNodes.filter((chapter) => chapter.parentId === volume.id); return <button type="button" className="outline-volume-row" key={volume.id} onClick={() => selectNode(volume)}><span className="outline-volume-index">{String(index + 1).padStart(2, "0")}</span><span className="outline-volume-copy"><strong>{volume.title}</strong><small>{volumeChapters.length ? `${volumeChapters.length} 个章节` : "尚未拆章节"} · {plan?.content.trim() ? "已写分卷规划" : "待补分卷规划"}</small></span><ChevronRight size={15} /></button>; }) : <div className="outline-volume-empty"><strong>还没有分卷</strong><span>请使用下方“添加结构节点”创建第一个分卷，再继续添加章节和场景。</span></div>}</div></div> : null}{selected.kind === "OUTLINE" && !workDesignReady ? <div className="node-plan-locked"><strong>故事大纲尚未开放</strong><span>还需补齐 {essentialPlanningSectionIds.length - essentialCompletedCount} 个核心设定，完成后开放故事大纲。</span><button type="button" className="secondary-action" onClick={() => { if (workDesignNode) { selectNode(workDesignNode); setSelectedPlanningSectionId(nextEssentialSectionId); } else setSelectedId(null); }}>{workDesignNode ? "去作品设定" : "回到项目总览"}</button></div> : null}{(selected.kind !== "CHAPTER" && selected.kind !== "VOLUME_MANAGER" && !(selected.kind === "OUTLINE" && !workDesignReady)) ? <div className={`node-plan-editor${selected.kind === "OUTLINE" ? " outline-plan-editor" : ""}`}   ><div className="section-heading"><div><h3>{selected.kind === "OUTLINE" ? "主线规划" : selected.kind === "VOLUME" ? "分卷规划" : "场景执行卡"}</h3><span>{nodePlanPrompt(selected.kind)}</span></div><small>{nodePlanDraft.trim() ? "已填写" : "待填写"}</small></div>
          {selected.kind === "OUTLINE" ? <div className="outline-context-panel"><div className="outline-context-heading"><div><span>上游依据</span><strong>作品设定</strong></div><small>{coreSettingItems.filter((item) => item.section?.content.trim()).length}/{coreSettingItems.length} 个核心设定</small></div>{coreSettingItems.some((item) => item.section?.content.trim()) ? <div className="outline-context-summary">{coreSettingItems.filter((item) => item.section?.content.trim()).map(({ definition, section }) => <span key={definition?.id}><b>{definition?.label}</b>{section?.content.trim()?.slice(0, 34)}</span>)}</div> : <div className="outline-context-empty"><strong>还没有可供主线使用的作品设定</strong><span>先完成故事前提、主角、对抗力量、赌注和结局，AI 才能生成贴合你作品的主线。</span></div>}{!workDesignReady ? <button type="button" className="secondary-action" onClick={() => { if (workDesignNode) { selectNode(workDesignNode); setSelectedPlanningSectionId(nextEssentialSectionId); } else setSelectedId(null); }}>{workDesignNode ? "先补齐作品设定" : "回到项目总览创建作品设定"}</button> : null}</div> : null}
          {selected.kind === "OUTLINE" ? <div className="outline-next-step"><div className="outline-next-copy"><span className="outline-next-kicker">现在先做这一步</span><strong>{nodePlanDraft.trim() ? "主线已确认，进入分卷规划" : "基于作品设定生成故事主线"}</strong><small>{nodePlanDraft.trim() ? "在分卷规划中建立阶段目标、卷末转折和章节归属。" : "AI 会参考人物目标、主题命题、核心冲突、赌注和结局落点，先生成一版可修改的主线候选。"}</small></div><div className="outline-next-actions"><button type="button" className="primary-action" onClick={() => nodePlanDraft.trim() ? (volumeManagerNode ? selectNode(volumeManagerNode) : void createStarterNode("VOLUME_MANAGER", "分卷管理")) : void generateNodePlan()} disabled={!nodePlanDraft.trim() && (!outlineProfile?.hasSecret || generatingNodePlan || !workDesignReady)}>{nodePlanDraft.trim() ? "进入分卷规划" : "基于设定生成主线"}</button>{nodePlanDraft.trim() ? <button type="button" className="secondary-action" onClick={() => setNodePlanDraft("")}>重新开始</button> : null}</div></div> : null}
          {(selected.kind === "OUTLINE" || selected.kind === "VOLUME") ? <><AiModelNote taskLabel={selected.kind === "OUTLINE" ? "大纲主线" : "分卷规划"} taskKey={selected.kind === "OUTLINE" ? "outline" : "volumePlanning"} profile={nodeTaskProfile} preference={nodeTaskPreference} /><label className="node-plan-guidance"><span>给 AI 的补充意见（可选）</span><textarea rows={2} value={nodePlanGuidance} onChange={(event) => setNodePlanGuidance(event.target.value)} placeholder={selected.kind === "OUTLINE" ? "例如：更偏悬疑，保留开放式结局，不要新增超自然设定" : "例如：这一卷重点写关系决裂，卷末必须留下身份真相"} /></label>{showNodePlanAiBar ? <div className="node-plan-ai-bar"><div><Sparkles size={15} /><span><strong>AI 共创</strong><small>结合上游设定生成候选，确认后才会写入正式规划</small></span></div><button type="button" className="secondary-action" onClick={() => void generateNodePlan()} disabled={!nodeTaskProfile?.hasSecret || generatingNodePlan || (selected.kind === "OUTLINE" && !workDesignReady) || (selected.kind === "VOLUME" && !outlinePlan?.content.trim()) || Boolean(nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING")}><Sparkles size={14} />{nodePlanJob?.status === "RUNNING" ? "推导中…" : "生成候选"}</button></div> : null}</> : null}
          {nodePlanJob && (nodePlanJob.status === "QUEUED" || nodePlanJob.status === "RUNNING") ? <div className="node-plan-job"><span>AI 正在梳理结构，完成后候选会出现在待定区</span><div><i style={{ width: `${nodePlanJob.progress}%` }} /></div><button type="button" onClick={() => void cancelJob(nodePlanJob.id)}>取消</button></div> : null}
          {selected.kind === "VOLUME" && !outlinePlan?.content.trim() ? <div className="node-plan-locked"><strong>分卷规划尚未开启</strong><span>先在故事大纲中确认正式主线，系统才会开放分卷目标与卷末转折规划。</span><button type="button" className="secondary-action" onClick={() => outlineNode && selectNode(outlineNode)}>返回故事大纲</button></div> : <>{selected.kind === "OUTLINE" ? <div className="node-plan-tabs" role="tablist"><button type="button" role="tab" aria-selected={nodePlanTab === "formal"} data-active={nodePlanTab === "formal" || undefined} onClick={() => setNodePlanTab("formal")}>正式主线<small>{nodePlanDraft.trim() ? "已确认" : "未确认"}</small></button><button type="button" role="tab" aria-selected={nodePlanTab === "pending"} data-active={nodePlanTab === "pending" || undefined} onClick={() => setNodePlanTab("pending")}>待定区<small>{nodePlanPendingDraft.trim() ? "有候选" : "暂无候选"}</small></button></div> : null}<textarea rows={selected.kind === "OUTLINE" ? 12 : 8} value={selected.kind === "OUTLINE" && nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft} onChange={(event) => selected.kind === "OUTLINE" && nodePlanTab === "pending" ? setNodePlanPendingDraft(event.target.value) : setNodePlanDraft(event.target.value)} placeholder={nodePlanPrompt(selected.kind)} />{selected.kind === "OUTLINE" && nodePlanTab === "pending" ? <div className="node-plan-actions"><button type="button" className="secondary-action" onClick={() => void saveNodePlan()} disabled={savingNodePlan || !nodePlanPendingDraft.trim()}>保存待定候选</button><button type="button" className="primary-action" onClick={() => void adoptNodePlan()} disabled={savingNodePlan || !nodePlanPendingDraft.trim()}><Check size={15} />采用为正式主线</button></div> : null}{selectedStoredPlan?.pendingContent?.trim() && selected.kind !== "OUTLINE" ? <div className="node-plan-candidate"><div><strong>待定候选</strong><small>AI 已生成，可编辑后采用</small></div><p>{selectedStoredPlan.pendingContent}</p><button type="button" className="secondary-action" onClick={() => { setNodePlanDraft(selectedStoredPlan.pendingContent); }}>载入编辑</button><button type="button" className="primary-action" onClick={() => void adoptNodePlan()} disabled={savingNodePlan}>采用候选</button></div> : null}<button type="button" className="primary-action" onClick={() => void saveNodePlan()} disabled={savingNodePlan || !(selected.kind === "OUTLINE" && nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft).trim()}><Check size={15} />{savingNodePlan ? "保存中…" : selected.kind === "OUTLINE" && nodePlanTab === "pending" ? "保存待定候选" : "保存规划"}</button></>}</div> : null}</> : null}
        {selected.kind === "VOLUME_MANAGER" && workspaceMode === "planning" && outlinePlan?.content.trim() ? <div id="volume-chapter-splitter" className="plan-create-row volume-manager-create-row"><div className="plan-create-copy"><strong>{volumePlanReady ? "拆章节" : "添加结构节点"}</strong><span>{volumePlanReady ? "选择分卷，逐章建立可执行结构" : "在分卷管理中创建分卷、章节和场景"}</span></div><select value={kind} onChange={(event) => { setKind(event.target.value as PlanNodeKind); setParentId(""); }} aria-label="节点类型">{creatableNodeKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={parentId} onChange={(event) => setParentId(event.target.value)} aria-label="父节点"><option value="" disabled>选择归属节点</option>{parentCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select><input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addNode(); }} placeholder={kind === "CHAPTER" ? "例如：第1章·入城" : kind === "VOLUME" ? "例如：第一卷·启程" : "例如：场景1"} aria-label="节点标题" /><button type="button" className="primary-action" onClick={() => void addNode()} disabled={!canAddNode}><Plus size={16} />{kind === "CHAPTER" ? "添加章节" : "新建节点"}</button></div> : null}
        {selected.kind === "WORK_DESIGN" ? <StoryPlanningWorkbench selectedSectionId={selectedPlanningSectionId} onSelectSection={setSelectedPlanningSectionId} onDirtyChange={setPlanningSectionDirty} /> : null}
        {selected.kind !== "WORK_DESIGN" && (nodeDraft.remoteChanged || splitDraft.remoteChanged) ? <div className="project-error" role="status">规划已有新版本，本地修改仍保留。<button type="button" className="secondary-action" disabled={savingNodePlan} onClick={() => { if (window.confirm("放弃本地未保存规划并读取最新版本吗？")) { nodeDraft.reload(); splitDraft.reload(); setError(null); } }}><ArchiveRestore size={14} />读取最新规划</button></div> : null}
        {selected.kind === "CHAPTER" && workspaceMode === "planning" ? <div className="planning-redirect-panel">
          <BookOpen size={18} /><strong>{selected.title}</strong><a href={`/writing#${selected.id}`}>开始创作</a>
        </div> : null}
        {selected.kind === "CHAPTER" && isChapterMode ? <ChapterCreationWorkspace
          key={`${currentProject.data?.projectId}:${selected.id}`}
          chapter={selected}
          volume={selectedVolume}
          chapterPlan={nodePlanDraft}
          pendingChapterPlan={selectedStoredPlan?.pendingContent}
          volumePlan={selectedVolumePlan?.content ?? ""}
          planDirty={nodePlanDirty}
          savingPlan={savingNodePlan}
          onPlanChange={setNodePlanDraft}
          onSavePlan={saveNodePlan}
          onAdoptPlan={adoptNodePlan}
          auditFlow={auditFlow.data}
          state={chapterManuscript}
          onPendingChange={setCandidatePanelsPending}
        /> : null}
      </main>}
      </div> : null}
    </section>
  );
}
