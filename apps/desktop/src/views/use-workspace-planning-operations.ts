import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { adoptPlanBatch, enqueuePlanningAiJob, errorMessage, savePlanningSection, type AiTaskPreference, type ModelProfile, type PlanNode, type PlanningSection } from "../lib/tauri-client";
import { buildVolumePlanTargetGuidance, nodePlanId, nodePlanPrompt, parseChapterPlanCandidates, parseVolumePlanCandidates } from "./project-workspace-utils";
import type { usePlanningDraft } from "./use-planning-draft";

type PlanningDraft = ReturnType<typeof usePlanningDraft>;
type PlanningModel = { profile: ModelProfile | undefined; preference: AiTaskPreference; guidance: string };
type WorkspacePlanningOptions = {
  projectId: string | undefined;
  selected: PlanNode | null;
  planningSections: PlanningSection[] | undefined;
  sectionsById: Map<string, PlanningSection>;
  volumeNodes: PlanNode[];
  chapterNodes: PlanNode[];
  nodeDraft: PlanningDraft;
  splitDraft: PlanningDraft;
  nodePlanTab: "formal" | "pending";
  nodeGeneration: PlanningModel & { targets: { wordCount: string; volumeCount: string; chapterCount: string } };
  splitGeneration: PlanningModel & {
    volume: PlanNode | undefined;
    busy: boolean;
    sectionId: string;
    targetCount: number;
    existingCount: number;
    batchSize: number;
  };
  onError: (error: string | null) => void;
  onVolumesAdopted: (firstVolumeId: string, hasNewEdits: boolean) => void;
};

export function useWorkspacePlanningOperations(options: WorkspacePlanningOptions) {
  const client = useQueryClient();
  const { projectId, selected, sectionsById, volumeNodes, chapterNodes, nodeDraft, splitDraft, nodePlanTab, onVolumesAdopted } = options;
  const planningSections = options.planningSections;
  const setError = options.onError;
  const { profile: nodeTaskProfile, preference: nodeTaskPreference, guidance: nodePlanGuidance, targets: volumePlanTargets } = options.nodeGeneration;
  const { volume: chapterSplitVolume, profile: chapterSplitProfile, preference: chapterSplitPreference,
    guidance: chapterSplitGuidance, busy: chapterSplitJobBusy, sectionId: chapterSplitSectionId,
    targetCount: chapterSplitTargetCount, existingCount: chapterSplitExistingCount, batchSize: chapterSplitBatchSize } = options.splitGeneration;
  const nodePlanDraft = nodeDraft.form.content;
  const nodePlanPendingDraft = nodeDraft.form.pendingContent;
  const chapterSplitPendingDraft = splitDraft.form.pendingContent;
  const [savingNodePlan, setSavingNodePlan] = useState(false);
  const [generatingNodePlan, setGeneratingNodePlan] = useState(false);
  const [generatingChapterSplit, setGeneratingChapterSplit] = useState(false);
  const currentNodeForm = useRef(nodeDraft.form);
  currentNodeForm.current = nodeDraft.form;

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
      const existing = (planningSections ?? []).filter((item) => item.content.trim()).map((item) => `${item.id}: ${item.content}`).join("\n");
      const targetGuidance = selected.kind === "VOLUME_MANAGER" ? buildVolumePlanTargetGuidance(volumePlanTargets) : "";
      const userGuidance = [nodePlanGuidance.trim(), targetGuidance].filter(Boolean).join("\n");
      await enqueuePlanningAiJob({ profileId: nodeTaskProfile.id, mode: "GENERATE", sectionId: nodePlanId(selected.id), sectionTitle: selected.title, sectionPrompt: nodePlanPrompt(selected.kind), existingContext: existing, referenceContent: "", userGuidance: userGuidance || "请先给出可执行的候选方案，保留作者可修改的空间。", allowRewrite: false, taskKey: selected.kind === "OUTLINE" ? "outline" : "volumePlanning", temperature: nodeTaskPreference.temperature ?? undefined, maxOutputTokens: nodeTaskPreference.maxOutputTokens ?? undefined });
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGeneratingNodePlan(false); }
  }

  async function generateChapterSplit() {
    if (!chapterSplitVolume || !chapterSplitProfile || generatingChapterSplit || chapterSplitJobBusy) return;
    setGeneratingChapterSplit(true);
    setError(null);
    try {
      const volumePlan = sectionsById.get(nodePlanId(chapterSplitVolume.id))?.content.trim() ?? "";
      const existing = (planningSections ?? []).filter((item) => item.content.trim()).map((item) => `${item.id}: ${item.content}`).join("\n");
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
    if (!chapterSplitVolume || savingNodePlan || !projectId) return;
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
      const { source: saved } = await adoptPlanBatch({
        expectedProjectId: projectId,
        parentId: chapterSplitVolume.id,
        expectedParentRevision: chapterSplitVolume.revision,
        expectedSourceVersion: snapshot.baseline.version ?? 0,
        source: snapshot.baseline,
        candidates,
      });
      splitDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["plan-nodes"] }),
        client.invalidateQueries({ queryKey: ["planning-sections"] }),
      ]);
    } catch (cause) {
      splitDraft.retainFailedSave(snapshot);
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
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
    if (!selected || selected.kind !== "VOLUME_MANAGER" || savingNodePlan || !projectId) return;
    const candidates = parseVolumePlanCandidates(nodePlanPendingDraft);
    if (!candidates.length) {
      setError("没有识别到可创建的分卷，请按“第X卷·标题｜阶段目标｜主要矛盾｜卷末转折”的格式填写。");
      return;
    }
    const existingTitles = new Set(volumeNodes.filter((node) => node.parentId === selected.id).map((node) => node.title));
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
      const { nodes: created, source: saved } = await adoptPlanBatch({
        expectedProjectId: projectId,
        parentId: selected.id,
        expectedParentRevision: selected.revision,
        expectedSourceVersion: snapshot.baseline.version ?? 0,
        source: snapshot.form,
        candidates,
      });
      const firstCreatedVolumeId = created[0]?.id ?? "";
      nodeDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      onVolumesAdopted(firstCreatedVolumeId || volumeNodes[0]?.id || "",
        currentNodeForm.current.pendingContent !== snapshot.form.pendingContent);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["plan-nodes"] }),
        client.invalidateQueries({ queryKey: ["planning-sections"] }),
      ]);
    } catch (cause) {
      nodeDraft.retainFailedSave(snapshot);
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    } finally {
      nodeDraft.finishSave(snapshot);
      setSavingNodePlan(false);
    }
  }

  return {
    savingNodePlan, generatingNodePlan, generatingChapterSplit,
    saveNodePlan, generateNodePlan, generateChapterSplit, adoptChapterSplitPlan, adoptNodePlan, adoptVolumeManagerPlan,
  };
}
