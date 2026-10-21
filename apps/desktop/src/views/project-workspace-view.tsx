import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ArrowLeft, BookOpen, Check, List, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { cancelJob, createPlanNode, errorMessage, getAuditFlowSettings, getCurrentProject, listModelProfiles, listPlanningSections, listPlanNodes, movePlanNode, updatePlanNodeChecked, type PlanNode, type PlanNodeKind } from "../lib/tauri-client";
import { useJobs } from "../lib/jobs-query";
import { AiModelNote } from "./ai-model-note";
import { ChapterFocusHeader } from "./chapter-focus-header";
import { ManuscriptExportPanel } from "./manuscript-export-panel";
import { ChapterCreationWorkspace } from "./chapter-creation-workspace";
import { useChapterManuscript } from "./use-chapter-manuscript";
import { usePlanningDraft } from "./use-planning-draft";
import { useWorkspacePlanningOperations } from "./use-workspace-planning-operations";
import { buildWorkspaceNodeIndex } from "./project-workspace-index";
import { PlanningDashboard } from "./planning-dashboard";
import { ProjectPlanTree } from "./project-plan-tree";
import { planningSectionGroups, planningStoryStateLabels, StoryPlanningWorkbench } from "./story-planning-workbench";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { resolveDiscussionPlanningTarget } from "../lib/discussion-source";
import { PlanningDiscussionSources } from "./planning-discussion-sources";
import { planNodeHref, resolvePlanNodeTarget } from "../lib/knowledge-navigation";
import { sourceReturnTo } from "../lib/manuscript-source";
import { ChapterDirectory } from "./chapter-directory";
import { ChapterCreateDialog } from "./chapter-create-dialog";
import { useWideWorkspace, WorkspacePanel } from "./workspace-panel";
import { PlanCandidateList } from "./plan-candidate-list";
import { PreparationEditor } from "./creation-preparation-view";
import { buildPreparationStages, preparationPrerequisites, preparationStatus } from "./creation-preparation";
import "./writing-planning.css";
import { useLayoutPreference } from "../lib/workspace-preferences";

import {
  isRootKind,
  isValidParentKind,
  kindLabels,
  lastWritingChapterKey,
  nodePlanId,
  parseChapterPlanCandidates,
  parseVolumePlanCandidates,
  resolveDefaultWritingChapter,
  rootDefinitions,
} from "./project-workspace-utils";

const planningDefinitionsById = new Map(planningSectionGroups.flatMap((group) => group.children).map((item) => [item.id, item]));

export function ProjectWorkspaceView(props: { mode?: "planning" | "chapters" | "writing"; embedded?: boolean } = {}) {
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
  const [kind, setKind] = useState<PlanNodeKind>("VOLUME");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPlanningSectionId, setSelectedPlanningSectionId] = useState("seed-tone");
  const [expandedPlanningGroups, setExpandedPlanningGroups] = useState<Set<string>>(() => new Set(["story-foundation"]));
  const [editTitle, setEditTitle] = useState("");
  const [moveParentId, setMoveParentId] = useState("");
  const [nodePlanTab, setNodePlanTab] = useState<"formal" | "pending">("formal");
  const [nodePlanGuidance, setNodePlanGuidance] = useState("");
  const [showVolumePlanning, setShowVolumePlanning] = useState(false);
  const [chapterSplitVolumeId, setChapterSplitVolumeId] = useState("");
  const [chapterSplitBatchCount, setChapterSplitBatchCount] = useState("20");
  const [chapterSplitGuidance, setChapterSplitGuidance] = useState("");
  const [planningSectionDirty, setPlanningSectionDirty] = useState(false);
  const onOutlinePending = useCallback((dirty: boolean, busy: boolean) => setPlanningSectionDirty(dirty || busy), []);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const directoryDocked = useWideWorkspace(isChapterMode ? 1280 : 900);
  const [directoryOpen, setDirectoryOpen] = useLayoutPreference(
    `${currentProject.data?.projectId ?? "current"}:${workspaceMode}:directory`, directoryDocked, directoryDocked);
  const [createChapterOpen, setCreateChapterOpen] = useState(false);
  const [excludedVolumes, setExcludedVolumes] = useState<Set<string>>(() => new Set());
  const [excludedChapters, setExcludedChapters] = useState<Set<string>>(() => new Set());
  const [structuredVolumes, setStructuredVolumes] = useState<{ text: string; candidates: Array<{ title: string; content: string }> } | null>(null);
  const [structuredChapters, setStructuredChapters] = useState<{ text: string; candidates: Array<{ title: string; content: string }> } | null>(null);
  useEffect(() => { if (!directoryDocked) setDirectoryOpen(false); }, [directoryDocked]);
  const discussionTarget = new URLSearchParams(window.location.search).get("discussionTarget");
  const targetProject = new URLSearchParams(window.location.search).get("targetProject");
  const referenceChapter = new URLSearchParams(window.location.search).get("referenceChapter");
  const planNodeTarget = new URLSearchParams(window.location.search).get("planNode");
  const returnTo = sourceReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
  const [targetError, setTargetError] = useState<string | null>(null);

  async function addNode() {
    if (!title.trim()) return;
    setError(null);
    try {
      await createPlanNode({ kind, title: title.trim(), ...(parentId ? { parentId } : {}) });
      setTitle("");
      if (isRootKind(kind)) setKind("VOLUME");
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

      if (starterKind === "CHAPTER") {
        setCreateChapterOpen(true);
        return;
      }

      const node = await createPlanNode({ kind: starterKind, title: starterTitle });
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

  const nodeIndex = useMemo(() => buildWorkspaceNodeIndex(nodes.data ?? []), [nodes.data]);
  const sectionsById = useMemo(() => new Map((planningSections.data ?? []).map((section) => [section.id, section])), [planningSections.data]);
  const bookPreferences = sectionsById.get("seed-tone");
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
      ? new URLSearchParams(window.location.search).get("tab") === "extraction" ? "extraction"
        : new URLSearchParams(window.location.search).get("tab") === "versions" ? "versions" : "candidate"
      : "manuscript",
  });
  const { chapterDirty, savingDraft, setManuscriptTab } = chapterManuscript;
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
  const volumeManagerNode = nodeIndex.nodesByKind.VOLUME_MANAGER[0];
  const outlineNode = nodeIndex.nodesByKind.OUTLINE[0];
  const outlineReady = preparationStatus(outlineNode ? sectionsById.get(nodePlanId(outlineNode.id)) : undefined, planningSections.data ?? []) === "confirmed";
  const preparationStages = buildPreparationStages(nodes.data ?? []);
  const outlineItem = { ...preparationStages[2].items[0], sectionId: selected?.kind === "OUTLINE" ? nodePlanId(selected.id) : null };
  const outlineBasisItems = preparationStages.slice(0, 2).flatMap((stage) => stage.items);
  const volumeNodes = nodeIndex.nodesByKind.VOLUME;
  const chapterNodes = nodeIndex.nodesByKind.CHAPTER;
  const volumesWithoutChapters = useMemo(() => volumeNodes.filter((volume) => !nodeIndex.chaptersByVolume.has(volume.id)), [nodeIndex, volumeNodes]);
  const volumePlanReady = volumeNodes.length > 0;
  const creatableNodeKinds = Object.entries(kindLabels).filter(([value]) => value === "VOLUME" || value === "SCENE");
  const chapterSplitVolume = volumeNodes.find((volume) => volume.id === chapterSplitVolumeId) ?? volumeNodes[0];
  const chapterSplitSectionId = chapterSplitVolume ? `chapter-split-${chapterSplitVolume.id}` : "";
  const chapterSplitStoredPlan = sectionsById.get(chapterSplitSectionId);
  const splitVolumeReady = preparationStatus(chapterSplitVolume ? sectionsById.get(nodePlanId(chapterSplitVolume.id)) : undefined, planningSections.data ?? []) === "confirmed";
  const splitDraft = usePlanningDraft(chapterSplitSectionId, chapterSplitStoredPlan, planningSections.data !== undefined);
  const chapterSplitPendingDraft = splitDraft.form.pendingContent;
  const setChapterSplitPendingDraft = (pendingContent: string) => splitDraft.setForm((current) => ({ ...current, pendingContent }));
  const chapterSplitCandidates = useMemo(() => structuredChapters?.text === chapterSplitPendingDraft
    ? structuredChapters.candidates : parseChapterPlanCandidates(chapterSplitPendingDraft), [chapterSplitPendingDraft, structuredChapters]);
  const chapterSplitExistingCount = chapterSplitVolume ? nodeIndex.chaptersByVolume.get(chapterSplitVolume.id)?.length ?? 0 : 0;
  const chapterSplitBatchSize = Math.min(50, Math.max(1, Number.parseInt(chapterSplitBatchCount, 10) || 20));
  const chapterSplitJob = chapterSplitSectionId
    ? (jobs.data ?? []).find((job) => {
      if (job.jobType !== "AI_PLANNING_GENERATE") return false;
      try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId === chapterSplitSectionId; } catch { return false; }
    })
    : undefined;
  const chapterSplitJobBusy = Boolean(chapterSplitJob?.status === "QUEUED" || chapterSplitJob?.status === "RUNNING");
  const parent = selected?.parentId ? nodeIndex.nodesById.get(selected.parentId) : undefined;
  const selectedVolume = parent?.kind === "VOLUME" && !parent.archived ? parent : undefined;
  const selectedVolumePlan = selectedVolume ? sectionsById.get(nodePlanId(selectedVolume.id)) : undefined;
  const nodePlanJob = selected && selected.kind !== "WORK_DESIGN"
    ? (jobs.data ?? []).find((job) => {
      if (job.jobType !== "AI_PLANNING_GENERATE") return false;
      try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId === nodePlanId(selected.id); } catch { return false; }
    })
    : undefined;
  const volumeManagerCandidates = useMemo(() => selected?.kind === "VOLUME_MANAGER"
    ? structuredVolumes?.text === nodePlanPendingDraft ? structuredVolumes.candidates : parseVolumePlanCandidates(nodePlanPendingDraft)
    : [], [selected?.kind, nodePlanPendingDraft, structuredVolumes]);
  const selectedVolumeCandidates = volumeManagerCandidates.filter((candidate) => !excludedVolumes.has(candidate.title));
  const selectedChapterCandidates = chapterSplitCandidates.filter((candidate) => !excludedChapters.has(candidate.title));
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
  const { savingNodePlan, generatingNodePlan, generatingChapterSplit,
    saveNodePlan, saveChapterSplitDraft, generateNodePlan, generateChapterSplit, adoptChapterSplitPlan, adoptNodePlan, adoptVolumeManagerPlan,
  } = useWorkspacePlanningOperations({
    projectId: currentProject.data?.projectId, selected, planningSections: planningSections.data, sectionsById,
    outlineSectionId: outlineNode ? nodePlanId(outlineNode.id) : undefined,
    nodeJobBusy: nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING",
    volumeNodes, chapterNodes, nodeDraft, splitDraft, nodePlanTab,
    preferencesDirty: selected?.kind === "VOLUME_MANAGER" && planningSectionDirty,
    nodeGeneration: { profile: nodeTaskProfile, preference: nodeTaskPreference, guidance: nodePlanGuidance },
    splitGeneration: { volume: chapterSplitVolume, profile: chapterSplitProfile, preference: chapterSplitPreference,
      guidance: chapterSplitGuidance, busy: chapterSplitJobBusy, sectionId: chapterSplitSectionId,
      existingCount: chapterSplitExistingCount, batchSize: chapterSplitBatchSize },
    onError: setError,
    excludedVolumes, excludedChapters,
    volumeCandidates: volumeManagerCandidates, chapterCandidates: chapterSplitCandidates,
    onVolumesAdopted: (firstVolumeId, hasNewEdits) => {
      setKind("VOLUME");
      setParentId(volumeManagerNode?.id ?? "");
      setChapterSplitVolumeId(firstVolumeId);
      setShowVolumePlanning(hasNewEdits);
    },
  });
  const chapterSplitBusy = generatingChapterSplit || chapterSplitJobBusy;
  const selectedChapterIndex = selected?.kind === "CHAPTER" ? chapterNodes.findIndex((node) => node.id === selected.id) : -1;
  const previousChapter = selectedChapterIndex > 0 ? chapterNodes[selectedChapterIndex - 1] : null;
  const nextChapter = selectedChapterIndex >= 0 && selectedChapterIndex < chapterNodes.length - 1 ? chapterNodes[selectedChapterIndex + 1] : null;
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
    setExcludedVolumes(new Set());
    setStructuredVolumes(null);
  }, [selected?.id]);
  useEffect(() => { setExcludedChapters(new Set()); setStructuredChapters(null); }, [chapterSplitSectionId]);
  useEffect(() => {
    const group = planningSectionGroups.find((item) => item.children.some((section) => section.id === selectedPlanningSectionId));
    if (group) setExpandedPlanningGroups((current) => new Set([...current, group.id]));
  }, [selectedPlanningSectionId]);

  useEffect(() => {
    if (selected?.kind !== "OUTLINE" && nodeDraft.baseline.pendingContent.trim()) setNodePlanTab("pending");
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
    if (!isChapterMode || selectedId) return;
    if (planNodeTarget !== null) {
      if (currentProject.isPending || nodes.isPending) return;
      if (currentProject.isError || nodes.isError) return;
      const target = resolvePlanNodeTarget(planNodeTarget, targetProject, currentProject.data?.projectId, nodes.data ?? [], true);
      if (!target || referenceChapter !== null || discussionTarget !== null) {
        setTargetError("目标章节已不可用或不属于当前项目，未打开其他章节。");
        return;
      }
      selectNode(target);
      return;
    }
    if (referenceChapter !== null) {
      if (currentProject.isPending || nodes.isPending) return;
      const target = chapterNodes.find((node) => node.id === referenceChapter);
      if (!target || targetProject !== null && currentProject.data?.projectId !== targetProject) {
        setTargetError("资料关联目标章节已不可用或不属于当前项目，未打开其他章节。");
        return;
      }
      selectNode(target);
      return;
    }
    if (discussionTarget !== null) {
      if (currentProject.isPending || nodes.isPending) return;
      const target = resolveDiscussionPlanningTarget(discussionTarget, nodes.data ?? [], [], true);
      if (!target || targetProject !== null && currentProject.data?.projectId !== targetProject) {
        setTargetError("讨论目标章节已不可用或不属于当前项目，未打开其他章节。");
        return;
      }
      selectNode(target.node);
      return;
    }
    if (!chapterNodes.length) return;
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
  }, [chapterNodes, currentProject.data?.projectId, currentProject.isPending, currentProject.isError, isChapterMode, selectedId, workspaceMode, discussionTarget, targetProject, referenceChapter, planNodeTarget, nodes.data, nodes.isPending, nodes.isError]);

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
    if (planNodeTarget !== null) {
      if (nodes.isPending || currentProject.isPending) return;
      if (currentProject.isError || nodes.isError) return;
      const target = resolvePlanNodeTarget(planNodeTarget, targetProject, currentProject.data?.projectId, nodes.data ?? []);
      if (!target || referenceChapter !== null || discussionTarget !== null) {
        setTargetError("目标规划已不可用或不属于当前项目，未打开其他规划项。");
        return;
      }
      selectNode(target);
      return;
    }
    if (discussionTarget !== null) {
      if (nodes.isPending || currentProject.isPending) return;
      const target = resolveDiscussionPlanningTarget(discussionTarget, nodes.data ?? [], Array.from(planningDefinitionsById.keys()));
      if (!target || targetProject !== null && currentProject.data?.projectId !== targetProject) {
        setTargetError("讨论目标规划已不可用或不属于当前项目，未打开其他规划项。");
        return;
      }
      if (selectNode(target.node) && target.sectionId) setSelectedPlanningSectionId(target.sectionId);
      return;
    }
    const requestedId = window.location.hash.slice(1);
    if (!requestedId) return;
    const requestedSection = planningSectionGroups.flatMap((group) => group.children).find((item) => item.id === requestedId);
    if (requestedSection && workDesignNode) {
      if (selectNode(workDesignNode)) setSelectedPlanningSectionId(requestedId);
      return;
    }
    const requestedNode = activeNodes.find((node) => node.id === requestedId);
    if (requestedNode) selectNode(requestedNode);
  }, [activeNodes, selectedId, workspaceMode, workDesignNode, discussionTarget, targetProject, referenceChapter, planNodeTarget, nodes.data, nodes.isPending, nodes.isError, currentProject.isPending, currentProject.isError, currentProject.data?.projectId]);

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

  function selectNode(node: PlanNode) {
    if (selected?.id === node.id) return true;
    if (savingDraft || savingNodePlan) {
      setError("内容正在保存，请稍后切换章节。");
      return false;
    }
    if ((chapterManuscript.draftNeedsPersistence || workspaceDirty) && !window.confirm(`${chapterManuscript.draftNeedsPersistence ? "当前草稿尚未保存在本地。" : unsavedMessage}确定切换吗？`)) return false;
    setTargetError(null);
    setSelectedId(node.id);
    setEditTitle(node.title);
    setMoveParentId(node.parentId ?? "");
    setManuscriptTab("candidate");
    return true;
  }

  function selectChapterSplitVolume(id: string) {
    if (savingNodePlan || id === chapterSplitVolume?.id) return;
    if (splitDraft.dirty && !window.confirm("当前拆章候选有未保存修改，确定放弃并切换分卷吗？")) return;
    setChapterSplitVolumeId(id);
    setChapterSplitGuidance("");
  }

  function selectPlanningSection(node: PlanNode, sectionId: string) {
    if (selected?.kind === "WORK_DESIGN" && planningSectionDirty && selectedPlanningSectionId !== sectionId && !window.confirm("当前设定有未保存修改，确定切换吗？")) return;
    if (selectNode(node)) setSelectedPlanningSectionId(sectionId);
  }

  async function moveSelected() {
    if (!selected) return;
    try { await movePlanNode({ id: selected.id, ...(moveParentId ? { parentId: moveParentId } : {}), expectedVersion: selected.revision }); await client.invalidateQueries({ queryKey: ["plan-nodes"] }); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  return (
    <section className="project-workspace writing-planning-workspace" data-workspace-mode={workspaceMode}>
      <div className="workspace-heading workspace-heading-with-action">
        <div>
          {props.embedded ? <h2 className="planning-section-title">分卷与细化</h2> : <h1>{isChapterMode ? "写作" : "大纲与规划"}</h1>}
          {returnTo && (!isChapterMode || !selected) ? <a className="secondary-action workspace-return-link" href={returnTo}><ArrowLeft size={15} />返回来源</a> : null}
        </div>
        <div className="workspace-heading-tools"><button type="button" className="icon-command" title={isChapterMode ? "章节目录" : "大纲目录"}
          aria-label={isChapterMode ? "章节目录" : "大纲目录"} aria-expanded={directoryOpen}
          onClick={() => setDirectoryOpen((open) => !open)}><List size={18} /></button>
        {currentProject.data ? <ManuscriptExportPanel
          key={`${currentProject.data.projectId}:${selected?.id ?? ""}`}
          projectId={currentProject.data.projectId}
          chapter={selected?.kind === "CHAPTER" && !selected.archived ? { id: selected.id, title: selected.title } : undefined}
          chapterDirty={chapterDirty}
          saving={savingDraft}
        /> : null}</div>
      </div>

      {nodes.isPending ? <p className="plan-loading">正在加载规划…</p> : null}
      {nodes.isError ? <p className="project-error" role="alert">无法加载规划：{errorMessage(nodes.error)}</p> : null}
      {planningSections.isError ? <p className="project-error" role="alert">无法读取规划：{errorMessage(planningSections.error)}
        <button type="button" className="secondary-action" onClick={() => void planningSections.refetch()}>重试读取规划</button></p> : null}
      {planNodeTarget !== null && currentProject.isError ? <p className="project-error" role="alert">无法核对目标项目：{errorMessage(currentProject.error)}</p> : null}
      {planNodeTarget !== null && (nodes.isError || currentProject.isError) ? <button type="button" className="secondary-action workspace-return-link" onClick={() => void Promise.all([nodes.refetch(), currentProject.refetch()])}><RefreshCw size={15} />重试定位</button> : null}
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {targetError ? <p className="project-error" role="alert">{targetError}</p> : null}

      {createChapterOpen && currentProject.data ? <ChapterCreateDialog projectId={currentProject.data.projectId} nodes={activeNodes}
        volumeId={selected?.kind === "VOLUME" ? selected.id : selectedVolume?.id} onClose={() => setCreateChapterOpen(false)}
        onCreated={(node) => { selectNode(node); if (!directoryDocked) setDirectoryOpen(false); }} /> : null}
      {!nodes.isPending && !nodes.isError ? <div className="plan-layout stage-two-layout" data-directory-open={directoryOpen && directoryDocked}>
      <WorkspacePanel open={directoryOpen} docked={directoryDocked} title={isChapterMode ? "章节目录" : "大纲目录"}
        className="workspace-directory" onClose={() => setDirectoryOpen(false)}>
      {workspaceMode === "writing" ? <ChapterDirectory nodes={visibleNodes} selectedId={selectedId}
        onSelect={(node) => { if (selectNode(node) && !directoryDocked) setDirectoryOpen(false); }}
        onCreate={() => setCreateChapterOpen(true)} /> : <ProjectPlanTree
        chapterMode={isChapterMode}
        expandedPlanningGroups={expandedPlanningGroups}
        onCreateStarterNode={createStarterNode}
        onSelectNode={(node) => {
          if (selectNode(node)) {
            if (node.kind === "WORK_DESIGN") setSelectedPlanningSectionId("seed-tone");
            if (!directoryDocked) setDirectoryOpen(false);
          }
        }}
        onSelectPlanningSection={selectPlanningSection}
        onToggleArchived={() => setShowArchived((value) => !value)}
        onTogglePlanningGroup={(groupId) => setExpandedPlanningGroups((current) => {
          const next = new Set(current);
          if (next.has(groupId)) next.delete(groupId);
          else next.add(groupId);
          return next;
        })}
        planningSections={planningSections.data ?? []}
        rootNodeFor={rootNodeFor}
        selectedId={selectedId}
        selectedPlanningSectionId={selectedPlanningSectionId}
        showArchived={showArchived}
        unorganizedRoots={unorganizedRoots}
        visibleNodes={visibleNodes}
        onCreateChapter={() => setCreateChapterOpen(true)}
      />}
      </WorkspacePanel>

      {!selected ? <PlanningDashboard
        onOpenPreferences={() => void createStarterNode("WORK_DESIGN", "本书偏好")}
        onOpenDirection={() => void createStarterNode("OUTLINE", "主线大纲")}
        onOpenStructure={() => void createStarterNode("VOLUME_MANAGER", "分卷与章节")}
        onCreateChapter={() => setCreateChapterOpen(true)}
        nodes={nodes.data ?? []} sections={planningSections.data ?? []}
        chapterNodes={chapterNodes}
        isChapterMode={isChapterMode}
        onOpenFirstChapter={() => chapterNodes[0] && selectNode(chapterNodes[0])}
      /> : <main className={`plan-inspector${selected.kind === "WORK_DESIGN" ? " plan-inspector-work-design" : ""}${selected.kind === "CHAPTER" && isChapterMode ? " chapter-focus-inspector" : ""}`} aria-label="节点工作区">
        {selected?.kind === "CHAPTER" && isChapterMode ? <ChapterFocusHeader
          canMoveToRoot={canMoveToRoot}
          chapterNodes={chapterNodes}
          editTitle={editTitle}
          moveCandidates={moveCandidates}
          moveParentId={moveParentId}
          nextChapter={nextChapter}
          onDelete={deleteSelected}
          onEditTitleChange={setEditTitle}
          onMove={moveSelected}
          onMoveParentChange={setMoveParentId}
          onCreateScene={createSceneForChapter}
          onSave={saveSelected}
          onSelectNode={selectNode}
          onToggleArchived={toggleArchived}
          previousChapter={previousChapter}
          selected={selected}
          selectedChapterIndex={selectedChapterIndex}
          selectedVolume={selectedVolume}
          workspaceMode={workspaceMode}
        /> : null}
        {selected.kind !== "WORK_DESIGN" ? <>{selected.kind !== "OUTLINE" && !(selected.kind === "CHAPTER" && isChapterMode) ? <div className="plan-inspector-heading"><h2>{selected.kind === "VOLUME_MANAGER" ? "分卷与章节" : selected.title}</h2></div> : null}
        {selected.kind !== "OUTLINE" && selected.kind !== "VOLUME_MANAGER" && !(selected.kind === "CHAPTER" && isChapterMode) ? <details className="structure-settings"><summary>结构设置</summary><div className="inspector-node-settings">
          <label className="inspector-name-field">节点名称<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="编辑节点标题" /></label>
          <div className="inspector-actions">
            <button type="button" className="primary-action" onClick={() => void saveSelected()} disabled={!editTitle.trim() || !titleDirty}><Check size={15} />保存名称</button>
            {selected.archived ? <button type="button" className="secondary-action" onClick={() => void toggleArchived(selected)}><ArchiveRestore size={15} />恢复</button> : <button type="button" className="secondary-action destructive-action" onClick={() => void deleteSelected()}><Trash2 size={15} />删除</button>}
          </div>
          <div className="inspector-move-row"><label>归属<select value={moveParentId} onChange={(event) => setMoveParentId(event.target.value)} aria-label="移动到父节点"><option value="" disabled={!canMoveToRoot}>{canMoveToRoot ? "顶层" : "选择父节点"}</option>{moveCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select></label><button type="button" className="secondary-action" onClick={() => void moveSelected()} disabled={!canMoveToRoot && !moveParentId}>移动</button></div>
        </div></details> : null}{selected.kind === "VOLUME_MANAGER" ? <div className="volume-manager-panel">
<div className="planning-basis-strip" role="status">
  <strong>{outlineReady ? "主线大纲已确认" : "主线大纲待确认或复核"}</strong>
  <a href="/planning?mode=prepare&item=outline">审阅主线大纲</a>
</div>
<details className="volume-book-preferences">
  <summary>本书偏好<small>{planningSectionDirty ? "未保存" : bookPreferences ? planningStoryStateLabels[bookPreferences.storyState] : "暂未设置"}</small></summary>
  <StoryPlanningWorkbench compact selectedSectionId="seed-tone" onDirtyChange={setPlanningSectionDirty} />
</details>
<p className="volume-book-preferences-preview">{bookPreferences?.content.trim() || "暂未设置"}</p>
<div className="section-heading">
<div>
<div className="creation-mode" role="group" aria-label="结构工具">
<button type="button" aria-pressed={!volumePlanReady || showVolumePlanning} disabled={savingNodePlan} onClick={() => setShowVolumePlanning(true)}>分卷方案</button>
<button type="button" aria-pressed={volumePlanReady && !showVolumePlanning} disabled={savingNodePlan || !volumePlanReady} onClick={() => setShowVolumePlanning(false)}>本卷章节</button>
</div>
</div>
<small>{volumePlanReady ? `${volumeNodes.length} 卷 · ${chapterNodes.length} 章` : "尚未创建分卷"}</small>
</div>
{!volumePlanReady || showVolumePlanning ? <div className="volume-manager-ai-panel"><details className="compact-ai-tool"><summary><Sparkles size={15} />生成分卷方案</summary>
<AiModelNote compact taskLabel="分卷规划" taskKey="volumePlanning" profile={volumeProfile} preference={volumePreference} />
<label className="node-plan-guidance">
<span>给 AI 的补充意见（可选）</span>
<textarea rows={2} value={nodePlanGuidance} onChange={(event) => setNodePlanGuidance(event.target.value)} placeholder="例如：第一卷尽快进入冲突，卷末必须有不可逆变化" />
</label>
<div className="node-plan-ai-bar">
<button type="button" className="secondary-action" onClick={() => void generateNodePlan()} disabled={!volumeProfile?.hasSecret || generatingNodePlan || Boolean(nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING") || !outlineReady || nodeDraft.dirty || planningSectionDirty}>
<Sparkles size={14} />{nodePlanJob?.status === "RUNNING" ? "生成中…" : "生成分卷方案"}</button>
</div></details>{nodePlanJob && (nodePlanJob.status === "QUEUED" || nodePlanJob.status === "RUNNING") ? <div className="node-plan-job">
<span>AI 正在规划分卷结构，完成后候选会出现在这里</span>
<div>
<i style={{ width: `${nodePlanJob.progress}%` }} />
</div>
<button type="button" onClick={() => void cancelJob(nodePlanJob.id)}>取消</button>
</div> : null}{nodePlanPendingDraft.trim() ? <div className="node-plan-candidate volume-manager-candidate">
<div>
<strong>AI 分卷候选</strong>
<small>{volumeManagerCandidates.length ? `已识别 ${volumeManagerCandidates.length} 个分卷，可修改后采用` : "未识别到分卷，请检查格式"}</small>
</div>
<PlanCandidateList candidates={volumeManagerCandidates} excluded={excludedVolumes} onExcludedChange={setExcludedVolumes}
  onChange={(text, candidates) => { setNodePlanPendingDraft(text); setStructuredVolumes({ text, candidates }); }} saving={savingNodePlan} ready={nodeDraft.ready} unit="卷" />
<details className="candidate-original"><summary>原始候选文本</summary><textarea disabled={!nodeDraft.ready} rows={6} value={nodePlanPendingDraft} onChange={(event) => { setStructuredVolumes(null); setNodePlanPendingDraft(event.target.value); }} aria-label="分卷候选" /></details>
<div className="node-plan-actions">
<button type="button" className="secondary-action" onClick={() => void saveNodePlan()} disabled={savingNodePlan || !nodeDraft.ready || !nodeDraft.dirty || Boolean(nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING")}>保存分卷候选</button>
<button type="button" className="primary-action" onClick={() => void adoptVolumeManagerPlan()} disabled={savingNodePlan || !nodeDraft.ready || !currentProject.data || !selectedVolumeCandidates.length || !outlineReady}>
<Check size={14} />采用并创建 {selectedVolumeCandidates.length} 个分卷</button>
</div>
</div> : null}</div> : null}{volumePlanReady && !showVolumePlanning ? <section className="chapter-split-ai-panel">
<div className="chapter-split-ai-heading">
<div>
<h3>本卷章节</h3>
</div>
{!splitVolumeReady ? <p className="preparation-review-warning" role="status">本卷规划尚未确认，章节候选保留。请先审定本卷的阶段目标、冲突与卷末转折。</p> : null}
</div>
<div className="chapter-split-controls">
<label>
<span>目标分卷</span>
<select value={chapterSplitVolume?.id ?? ""} disabled={savingNodePlan} onChange={(event) => selectChapterSplitVolume(event.target.value)} aria-label="拆章节目标分卷">{volumeNodes.map((volume, index) => <option key={volume.id} value={volume.id}>{String(index + 1).padStart(2, "0")} · {volume.title}</option>)}</select>
</label>
<label>
<span>本批章节数</span>
<input type="number" min="1" max="50" inputMode="numeric" value={chapterSplitBatchCount} onChange={(event) => setChapterSplitBatchCount(event.target.value)} aria-label="本批章节数" />
</label>
<div className="chapter-split-progress">
<span>本卷进度</span>
<strong>{chapterSplitExistingCount} 章</strong>
<small>下一批从第 {chapterNodes.length + 1} 章开始</small>
</div>
</div>
<details className="compact-ai-tool"><summary><Sparkles size={15} />拆分本卷章节</summary>
<AiModelNote compact taskLabel="章节拆分" taskKey="chapterSplit" profile={chapterSplitProfile} preference={chapterSplitPreference} runMultiplier={Number(chapterSplitBatchCount) || 1} />
<label className="node-plan-guidance">
<span>本章拆分补充要求（可选）</span>
<textarea rows={2} value={chapterSplitGuidance} onChange={(event) => setChapterSplitGuidance(event.target.value)} placeholder="例如：每章只推进一个主要事件，前 5 章节奏要快，保留卷末三章做连续反转" />
</label>
<div className="node-plan-ai-bar">
<button type="button" className="secondary-action" onClick={() => void generateChapterSplit()} disabled={!chapterSplitProfile?.hasSecret || chapterSplitBusy || !chapterSplitSectionId || !outlineReady || !splitVolumeReady || splitDraft.dirty || planningSectionDirty}>
<Sparkles size={14} />{chapterSplitBusy ? "生成中…" : "拆分本卷章节"}</button>
</div></details>{chapterSplitJob && (chapterSplitJob.status === "QUEUED" || chapterSplitJob.status === "RUNNING") ? <div className="node-plan-job">
<span>AI 正在拆分「{chapterSplitVolume?.title}」，完成后候选会出现在这里</span>
<div>
<i style={{ width: `${chapterSplitJob.progress}%` }} />
</div>
<button type="button" onClick={() => void cancelJob(chapterSplitJob.id)}>取消</button>
</div> : null}{chapterSplitPendingDraft.trim() ? <div className="node-plan-candidate chapter-split-candidate">
<div>
<strong>章节拆分候选</strong>
<small>{chapterSplitCandidates.length ? `已识别 ${chapterSplitCandidates.length} 章，可修改后采用` : "未识别到章节，请检查格式"}</small>
</div>
<PlanCandidateList candidates={chapterSplitCandidates} excluded={excludedChapters} onExcludedChange={setExcludedChapters}
  onChange={(text, candidates) => { setChapterSplitPendingDraft(text); setStructuredChapters({ text, candidates }); }} saving={savingNodePlan} ready={splitDraft.ready} unit="章" />
<details className="candidate-original"><summary>原始候选文本</summary><textarea disabled={!splitDraft.ready} rows={8} value={chapterSplitPendingDraft} onChange={(event) => { setStructuredChapters(null); setChapterSplitPendingDraft(event.target.value); }} aria-label="章节拆分候选" /></details>
<div className="node-plan-actions">
<button type="button" className="secondary-action" disabled={savingNodePlan || chapterSplitBusy} onClick={() => {
  if (window.confirm("清空本批章节候选吗？已有章节与正式计划保留。")) setChapterSplitPendingDraft("");
}}>清空候选</button>
<button type="button" className="secondary-action" onClick={() => void saveChapterSplitDraft()} disabled={savingNodePlan || !splitDraft.ready || !splitDraft.dirty || chapterSplitBusy}>保存章节候选</button>
<button type="button" className="primary-action" onClick={() => void adoptChapterSplitPlan()} disabled={savingNodePlan || !splitDraft.ready || !currentProject.data || !selectedChapterCandidates.length || !outlineReady || !splitVolumeReady}>
<Check size={14} />采用并创建 {selectedChapterCandidates.length} 章</button>
</div>
</div> : null}</section> : null}
</div> : null}{selected.kind === "OUTLINE" ? <>
          <div className="preparation-editor planning-outline-editor">
            <PreparationEditor key={selected.id} item={outlineItem} sections={planningSections.data ?? []}
              basisItems={outlineBasisItems} prerequisites={preparationPrerequisites(preparationStages, "outline", planningSections.data ?? [])}
              onPendingChange={onOutlinePending} />
          </div>
        </> : null}{selected.kind !== "CHAPTER" && selected.kind !== "VOLUME_MANAGER" && selected.kind !== "OUTLINE" ? <div className="compact-plan-editor">
          <div className="compact-plan-toolbar">
            <div className="creation-mode" role="group" aria-label="规划内容">
              <button type="button" aria-pressed={nodePlanTab === "formal"} onClick={() => setNodePlanTab("formal")}>正式内容</button>
              <button type="button" aria-pressed={nodePlanTab === "pending"} onClick={() => setNodePlanTab("pending")}>草稿与候选</button>
            </div>
            {nodePlanTab === "formal" ? <button type="button" className="secondary-action" disabled={savingNodePlan || !nodeDraft.ready} onClick={() => {
              if (nodePlanPendingDraft.trim() && !window.confirm("已有待定候选，用正式内容替换候选吗？")) return;
              setNodePlanPendingDraft(nodePlanDraft); setNodePlanTab("pending");
            }}>编辑规划</button> : null}
          </div>
          <textarea aria-label={nodePlanTab === "formal" ? "正式规划" : "规划草稿"} rows={14}
            readOnly={nodePlanTab === "formal" || !nodeDraft.ready} value={nodePlanTab === "pending" ? nodePlanPendingDraft : nodePlanDraft}
            onChange={(event) => setNodePlanPendingDraft(event.target.value)} placeholder="尚无内容" />
          <div className="compact-plan-savebar">
            <label>内容状态<select aria-label="内容状态" disabled={!nodeDraft.ready} value={nodeDraft.form.storyState} onChange={(event) => nodeDraft.setForm((current) => ({
              ...current, storyState: event.target.value as typeof current.storyState,
            }))}>{Object.entries(planningStoryStateLabels).map(([state, label]) => <option key={state} value={state}
              disabled={(state === "CONFIRMED" || state === "LOCKED") && !nodePlanDraft.trim() && !nodePlanPendingDraft.trim()
                || state === "AI_SUGGESTED" && !nodePlanPendingDraft.trim()}>{label}</option>)}</select></label>
            <div><button type="button" className="secondary-action" onClick={() => void saveNodePlan()} disabled={savingNodePlan || !nodeDraft.ready || !nodePlanDirty}>
              {savingNodePlan ? "保存中…" : nodePlanTab === "pending" ? "保存草稿" : "保存规划"}</button>
              {nodePlanTab === "pending" ? <button type="button" className="primary-action" onClick={() => void adoptNodePlan()}
                disabled={savingNodePlan || !nodeDraft.ready || !nodePlanPendingDraft.trim()}><Check size={15} />确认为正式规划</button> : null}</div>
          </div>
          {selected.kind === "VOLUME" ? <details className="compact-ai-tool"><summary><Sparkles size={15} />生成分卷规划</summary>
            <AiModelNote compact taskLabel="分卷规划" taskKey="volumePlanning" profile={nodeTaskProfile} preference={nodeTaskPreference} />
            <label>补充要求<textarea rows={3} value={nodePlanGuidance} onChange={(event) => setNodePlanGuidance(event.target.value)} /></label>
            <button type="button" className="secondary-action" onClick={() => void generateNodePlan()}
              disabled={!nodeTaskProfile?.hasSecret || generatingNodePlan || Boolean(nodePlanJob?.status === "QUEUED" || nodePlanJob?.status === "RUNNING")}>
              <Sparkles size={14} />{generatingNodePlan ? "提交中…" : "生成分卷规划"}</button>
          </details> : null}
          {nodePlanJob && (nodePlanJob.status === "QUEUED" || nodePlanJob.status === "RUNNING") ? <div className="node-plan-job"><span>生成中 · {nodePlanJob.progress}%</span>
            <button type="button" onClick={() => void cancelJob(nodePlanJob.id)}>取消生成</button></div> : null}
        </div> : null}</> : null}
        {selected.kind === "VOLUME_MANAGER" ? <div className="structure-create-tools">
          <button type="button" className="primary-action" onClick={() => setCreateChapterOpen(true)}><Plus size={15} />新建章节</button>
          <details><summary>新建分卷或场景</summary><div className="plan-create-row">
            <select value={kind} onChange={(event) => { setKind(event.target.value as PlanNodeKind); setParentId(""); }} aria-label="节点类型">
              {creatableNodeKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select value={parentId} onChange={(event) => setParentId(event.target.value)} aria-label="父节点"><option value="" disabled>选择归属</option>
              {parentCandidates.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select>
            <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="节点标题" placeholder="名称" />
            <button type="button" className="primary-action" onClick={() => void addNode()} disabled={!canAddNode}><Plus size={15} />创建{kindLabels[kind]}</button>
          </div></details>
        </div> : null}
        {selected.kind !== "WORK_DESIGN" && selected.kind !== "CHAPTER" ? <PlanningDiscussionSources sectionId={nodePlanId(selected.id)} /> : null}
        {(selected.kind === "VOLUME_MANAGER" && !showVolumePlanning && volumePlanReady ? chapterSplitJob : nodePlanJob)?.status === "FAILED"
          ? <p className="project-error" role="alert">生成失败：{(selected.kind === "VOLUME_MANAGER" && !showVolumePlanning && volumePlanReady ? chapterSplitJob : nodePlanJob)?.errorSummary}
            <a href="/jobs">查看任务记录</a></p> : null}
        {selected.kind === "WORK_DESIGN" ? <StoryPlanningWorkbench selectedSectionId={selectedPlanningSectionId} onSelectSection={setSelectedPlanningSectionId} onDirtyChange={setPlanningSectionDirty} /> : null}
        {selected.kind !== "WORK_DESIGN" && (nodeDraft.remoteChanged || splitDraft.remoteChanged) ? <div className="project-error" role="status">规划已有新版本，本地修改仍保留。<button type="button" className="secondary-action" disabled={savingNodePlan} onClick={() => { if (window.confirm("放弃本地未保存规划并读取最新版本吗？")) { nodeDraft.reload(); splitDraft.reload(); setError(null); } }}><ArchiveRestore size={14} />读取最新规划</button></div> : null}
        {selected.kind === "CHAPTER" && workspaceMode === "planning" ? <div className="planning-redirect-panel">
          <BookOpen size={18} /><strong>{selected.title}</strong><a href={`/writing#${selected.id}`}>开始创作</a>
          {currentProject.data ? <a href={planNodeHref(selected.id, currentProject.data.projectId, returnTo ?? undefined, true)}>查看本章计划</a> : null}
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
          planReady={nodeDraft.ready}
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
