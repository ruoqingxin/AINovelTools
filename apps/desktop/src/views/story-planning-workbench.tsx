import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileUp, PenLine, RotateCcw, Save, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useJobs } from "../lib/jobs-query";
import { classifyAiFailure } from "../lib/ai-failure";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  errorMessage,
  cancelJob,
  enqueueProjectSettingSummaryRefresh,
  enqueuePlanningAiJob,
  listPlanningSections,
  listModelProfiles,
  retryJob,
  savePlanningSection,
  type PlanningSection,
  type PlanningStoryState,
  type Job,
  type PlanningAiJobInput,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";
import { usePlanningDraft } from "./use-planning-draft";
import { PlanningDiscussionSources } from "./planning-discussion-sources";
import { FreePlanningEditor } from "./free-planning-editor";
import { PlanningSectionDiscussion } from "./planning-section-discussion";
import { identityLabel, planningSectionIdentity } from "../lib/content-taxonomy";
import { getCurrentProject } from "../lib/tauri-client";
import { ContentTypeLabel, FormalContent, useInAiWorkspace } from "./content-identity";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

type PlanningItem = { id: string; label: string; prompt: string; guidance: string };
type PlanningGroup = { id: string; label: string; children: PlanningItem[] };
type PlanningStartMode = "WRITE" | "AI" | "IMPORT";

export const planningSectionGroups: PlanningGroup[] = [
  {
    id: "story-foundation",
    label: "开篇定位",
    children: [
      { id: "seed-premise", label: "核心前提与开局情境", prompt: "主角在什么异常局面中，必须完成什么高风险目标，否则会失去什么最重要的东西", guidance: "用 1—3 句话写清特殊世界或规则、突发事件、主角目标和失败后果。先回答“故事为什么现在开始”，不用展开背景百科。" },
      { id: "seed-genre", label: "题材", prompt: "你想写什么题材？", guidance: "先确定一种主要题材。" },
      { id: "seed-genre-promise", label: "阅读期待", prompt: "你最想让读者感受到什么？", guidance: "记录一种主要阅读感受。" },
      { id: "seed-hook", label: "核心卖点与独特钩子", prompt: "为什么读者要点开这本书，而不是同类作品", guidance: "提炼一个最独特的身份、能力、世界、关系或叙事钩子，最好浓缩成“谁利用什么，在什么世界对抗什么”的一句话。" },
      { id: "seed-tone", label: "本书偏好", prompt: "记录作者明确提出的预计篇幅、卷章安排、风格基调和表达边界", guidance: "只记录作者已决定的偏好，允许大致范围；未提到的内容留白，不要求确定感情线、主角底线或剧情走向。" },
    ],
  },
  {
    id: "story-engine",
    label: "故事驱动",
    children: [
      { id: "engine-protagonist", label: "主角", prompt: "主角是个怎样的人？", guidance: "用几句话介绍主角。" },
      { id: "engine-motivation", label: "行动动机", prompt: "什么让主角必须行动？", guidance: "写下主角无法置身事外的原因。" },
      { id: "engine-antagonism", label: "主要阻力", prompt: "主角最大的阻碍是什么？", guidance: "先确定一项主要阻力。" },
      { id: "engine-stakes", label: "失败代价", prompt: "如果失败，主角会失去什么？", guidance: "先写最重要的损失。" },
      { id: "engine-theme", label: "核心谜团与主题命题", prompt: "读者要追问什么真相，人物选择最终在讨论什么问题", guidance: "把“谜团（真相是什么）”和“主题（故事在说什么）”分开写。谜团负责追读，主题负责让结局有余味。" },
      { id: "engine-ending", label: "结局状态与承诺兑现", prompt: "主角最终达成了什么、放弃了什么，开局问题和读者期待如何得到回答", guidance: "不用写死每个细节，但要确定主角最后成为怎样的人，以及主线、人物弧光、爽点、情感点和核心谜团如何收束。" },
    ],
  },
  {
    id: "story-growth",
    label: "连载建设",
    children: [
      { id: "cast-core-relationship", label: "核心关系与关系变化", prompt: "哪段关系承载主要情感变化，它的起点、转折和终点是什么", guidance: "不要只写人物标签，按“关系起点 → 关键转折 → 最终状态”记录彼此需要、伤害、背叛、和解或选择。" },
      { id: "cast-supporting", label: "关键角色与叙事功能", prompt: "重要配角想要什么、害怕失去什么、与主角冲突什么，以及他们为剧情提供什么功能", guidance: "每个关键角色至少写欲望、恐惧、冲突点和叙事功能。功能可以是镜像、助推、阻碍、见证、反转或牺牲。" },
      { id: "cast-arcs", label: "人物弧光、秘密与信息差", prompt: "核心人物会如何变化，各自隐藏什么秘密，最终必须做出什么选择", guidance: "为核心角色写表面身份、真实欲望、不能说的秘密和最终选择。秘密应服务于反转，人物变化应由连续选择推动。" },
      { id: "frame-setting", label: "舞台、硬规则与资源限制", prompt: "哪些世界规则、力量上限、资源限制和禁忌会直接影响人物行动", guidance: "只写会影响剧情的规则：力量上限、行动代价、稀缺资源、身份秩序和禁忌。每条规则都最好能限制主角、制造冲突并提供解法。" },
      { id: "frame-history", label: "历史因果、势力与矛盾来源", prompt: "世界为何变成现在这样，哪些势力在争什么，主角卷入后会改变谁的利益", guidance: "先写当前矛盾的因果链和三层势力：近处、中层、顶层。无需编完整年史，只保留会影响当下冲突的历史。" },
      { id: "frame-narrative", label: "视角、信息与叙事节奏", prompt: "由谁讲述故事，秘密何时揭示，一卷解决什么问题，高潮和章末钩子如何安排", guidance: "确定人称、视角数量、信息差策略、每卷阶段目标、大小高潮间隔和章末钩子。升级流可采用贴近主角的第三人称，辅以少量配角视角。" },
    ],
  },
]; 
const sections = planningSectionGroups.flatMap((group) => group.children);
const sectionIds = new Set(sections.map((section) => section.id));
export const essentialPlanningSectionIds = [
  "seed-premise",
  "seed-genre",
  "seed-genre-promise",
  "engine-protagonist",
  "engine-motivation",
  "engine-antagonism",
  "engine-stakes",
  "engine-ending",
] as const;

export const planningStoryStateLabels: Record<PlanningStoryState, string> = {
  UNSET: "尚未记录",
  UNKNOWN: "明确未知",
  DEFERRED: "暂不决定",
  AUTHOR_RESERVED: "作者保留",
  AI_SUGGESTED: "AI 建议",
  CONFIRMED: "作者已确认",
  LOCKED: "作者已锁定",
  RETIRED: "已废弃或替代",
};

export function nextIncompletePlanningSectionId(currentId: string, completedIds: ReadonlySet<string>) {
  const currentIndex = sections.findIndex((section) => section.id === currentId);
  const ordered = [...sections.slice(currentIndex + 1), ...sections.slice(0, Math.max(currentIndex + 1, 0))];
  return ordered.find((section) => !completedIds.has(section.id))?.id ?? null;
}

function planningJobInput(job: Job): PlanningAiJobInput | null {
  if (job.jobType !== "AI_PLANNING_GENERATE" && job.jobType !== "AI_PLANNING_EXTRACT") return null;
  try {
    return JSON.parse(job.payload) as PlanningAiJobInput;
  } catch {
    return null;
  }
}

type StoryPlanningWorkbenchProps = {
  compact?: boolean;
  selectedSectionId?: string;
  onSelectSection?: (sectionId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function StoryPlanningWorkbench(props: StoryPlanningWorkbenchProps) {
  const workspace = useInAiWorkspace();
  if (props.selectedSectionId && !sectionIds.has(props.selectedSectionId)) return <p role="alert">准备节点不存在，未打开其他内容。</p>;
  return workspace ? <EditableStoryPlanningWorkbench {...props} /> : <StoryPlanningContent {...props} />;
}

function StoryPlanningContent(props: StoryPlanningWorkbenchProps) {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const id = props.selectedSectionId ?? "seed-tone";
  const definition = sectionsDefinition(id);
  const section = sections.data?.find((item) => item.id === id);
  if (sections.isPending || project.isPending) return <p role="status">正在读取正式内容…</p>;
  if (sections.isError || project.isError) return <p role="alert">{errorMessage(sections.error ?? project.error)}</p>;
  if (!project.data) return null;
  return <FormalContent title={definition?.label ?? id} identity={planningSectionIdentity(id)} content={section?.content ?? ""}
    pending={Boolean(section?.pendingContent.trim())} status={section ? planningStoryStateLabels[section.storyState] : "尚未记录"}
    target={{ projectId: project.data.projectId, workflow: "section", item: id }} />;
}

function sectionsDefinition(id: string) { return sections.find((section) => section.id === id); }

function EditableStoryPlanningWorkbench(props: StoryPlanningWorkbenchProps) {
  const client = useQueryClient();
  const storedSections = useQuery({
    queryKey: ["planning-sections"],
    queryFn: listPlanningSections,
  });
  const jobs = useJobs();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const selectedId = props.selectedSectionId ?? "seed-tone";
  const storedSelected = useMemo(() => storedSections.data?.find((section) => section.id === selectedId), [storedSections.data, selectedId]);
  const planningDraft = usePlanningDraft(selectedId, storedSelected, storedSections.data !== undefined);
  const { form, setForm, baseline, saving, dirty } = planningDraft;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingMemoryNeedsRefresh, setSettingMemoryNeedsRefresh] = useState(false);
  const [refreshingSettingMemory, setRefreshingSettingMemory] = useState(false);
  const [editorTab, setEditorTab] = useState<"formal" | "pending">("formal");
  const [showEditor, setShowEditor] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [startMode, setStartMode] = useState<PlanningStartMode | null>("WRITE");
  const [pendingAction, setPendingAction] = useState<"AI" | "IMPORT" | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [operationGuidance, setOperationGuidance] = useState("");
  const [allowImportRewrite, setAllowImportRewrite] = useState(false);
  const [previousForm, setPreviousForm] = useState<PlanningSection | null>(null);
  const [discussionBusy, setDiscussionBusy] = useState(false);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const selectedGroup = planningSectionGroups.find((group) => group.children.some((item) => item.id === selectedId));
  const pendingDirty = form.pendingContent !== baseline.pendingContent;
  const sectionStatus = pendingDirty
    ? { label: "候选有未保存修改", hint: "点击“保存待定内容”后，修改才会保留" }
    : form.content.trim() && form.pendingContent.trim()
      ? { label: `${planningStoryStateLabels[form.storyState]} · 候选待确认`, hint: "候选可以继续修改，确认后才会形成新的正式版本" }
      : form.content.trim()
        ? { label: planningStoryStateLabels[form.storyState], hint: "正式区只读，如需修改请转为待定内容" }
        : form.pendingContent.trim()
          ? { label: `${planningStoryStateLabels[form.storyState]} · 候选已保存`, hint: "候选不会进入正式上下文，可以继续修改或确认" }
          : { label: planningStoryStateLabels[form.storyState], hint: "空内容不等于错误，也可以明确标记未知、暂不决定或作者保留" };
  const formalDirty = form.content !== baseline.content
    || form.storyState !== baseline.storyState
    || form.rationale !== baseline.rationale
    || form.consequence !== baseline.consequence
    || JSON.stringify(form.references) !== JSON.stringify(baseline.references);
  const chatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "workDesign");
  const chatPreference = resolveTaskPreference(aiPreferences.data, "workDesign");
  const sectionJobs = useMemo(() => (jobs.data ?? []).filter((job) => planningJobInput(job)?.sectionId === selectedId), [jobs.data, selectedId]);
  const activeJob = sectionJobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const latestJob = sectionJobs[0];
  const aiBusy = generating || importing || Boolean(activeJob) || discussionBusy;
  useUnsavedChangesGuard(dirty || saving || discussionBusy, "当前准备笔记有未保存修改或进行中的操作。");
  const visibleJob = activeJob ?? (latestJob?.status === "FAILED" || latestJob?.status === "CANCELLED" ? latestJob : null);
  const visibleFailure = visibleJob?.status === "FAILED"
    ? classifyAiFailure(visibleJob.errorSummary)
    : null;
  const existingFormalContext = useMemo(() => (storedSections.data ?? [])
    .filter((item) => sectionIds.has(item.id) && item.content.trim() && item.id !== selectedId)
    .map((item) => `[${identityLabel(planningSectionIdentity(item.id))}] ${item.id}: ${item.content}`)
    .join("\n"), [storedSections.data, selectedId]);
  const selectedAiPrompt = `内容分类：${identityLabel(planningSectionIdentity(selectedId))}。未归类笔记不代表正式设定事实。当前节点“${selectedDefinition.label}”：${selectedDefinition.prompt}。填写参考：${selectedDefinition.guidance}`;
  useEffect(() => {
    setError(null);
    setNotice(null);
    setShowEditor(true);
    setEditorTab("formal");
    setStartMode("WRITE");
    setPendingAction(null);
    setPendingFiles([]);
    setOperationGuidance("");
    setAllowImportRewrite(false);
    setPreviousForm(null);
  }, [selectedId]);

  useEffect(() => {
    if (baseline.pendingContent.trim()) setEditorTab("pending");
  }, [selectedId, baseline.pendingContent]);

  useEffect(() => {
    if (latestJob?.status === "SUCCEEDED") {
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice("AI 内容已生成并自动保存到候选区");
    } else if (latestJob?.status === "FAILED") {
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
      if (latestJob.errorSummary?.includes("保留到待定区")) {
        setNotice("AI 返回不完整，已保留部分内容到待定区，可检查任务提示后重试");
      }
    }
  }, [client, latestJob?.errorSummary, latestJob?.id, latestJob?.status]);

  useEffect(() => {
    props.onDirtyChange?.(dirty || saving || discussionBusy);
    return () => props.onDirtyChange?.(false);
  }, [dirty, saving, discussionBusy, props.onDirtyChange]);

  function confirmDiscardPending() {
    if (!pendingDirty) return true;
    if (!window.confirm("当前候选有未保存修改，确定放弃这些修改吗？")) return false;
    restoreUnsavedPending();
    return true;
  }

  function restoreUnsavedPending() {
    if (!pendingDirty) return;
    setForm((current) => ({ ...current, pendingContent: baseline.pendingContent }));
    setNotice("未保存的候选修改已恢复，当前显示的是上次保存的候选内容");
  }

  function switchEditorTab(tab: "formal" | "pending") {
    if (tab === editorTab) return;
    setEditorTab(tab);
  }

  function appendImportFiles(files: File[]) {
    if (!files.length) return;
    setStartMode("IMPORT");
    setPendingAction("IMPORT");
    setPendingFiles((current) => {
      const existing = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...files.filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`))];
    });
    setOperationGuidance("");
    setAllowImportRewrite(false);
  }

  async function save() {
    const snapshot = planningDraft.beginSave();
    if (!snapshot) return;
    setError(null);
    setNotice(null);
    try {
      const formalChanged = editorTab === "formal" && formalDirty;
      const saved = await savePlanningSection({ ...snapshot.form, version: snapshot.baseline.version });
      planningDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setSettingMemoryNeedsRefresh(formalChanged);
      setNotice(editorTab === "pending" ? "待定内容已保存" : formalChanged ? "正式内容已保存，后续 AI 会读取最新内容" : "正式内容已保存");
      setPreviousForm(null);
    } catch (cause) {
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    } finally {
      planningDraft.finishSave(snapshot);
    }
  }

  function startWriting() {
    setShowEditor(true);
    if (form.pendingContent.trim() && !window.confirm("已有待定候选，用正式内容替换候选吗？")) return;
    setForm((current) => ({ ...current, pendingContent: current.content }));
    setEditorTab("pending");
    setStartMode("WRITE");
    setPendingAction(null);
    setNotice(null);
  }

  async function importSectionFile() {
    if (!confirmDiscardPending()) return;
    const files = pendingFiles;
    if (!files.length) return;
    if (!chatProfile) { setError("请先在设置中配置一个可用的聊天模型"); return; }
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const content = (await Promise.all(files.map(async (file) => `===== 文件：${file.name} =====\n${await file.text()}`))).join("\n\n");
      await enqueuePlanningAiJob({ profileId: chatProfile.id, mode: "EXTRACT", sectionId: selectedId, sectionTitle: selectedDefinition.label, sectionPrompt: selectedAiPrompt, existingContext: existingFormalContext, referenceContent: content, userGuidance: operationGuidance, allowRewrite: allowImportRewrite, taskKey: "workDesign", temperature: chatPreference.temperature ?? undefined, maxOutputTokens: chatPreference.maxOutputTokens ?? undefined, sourceName: files.map((file) => file.name) });
      setPendingAction(null);
      setStartMode(null);
      setPendingFiles([]);
      setOperationGuidance("");
      setAllowImportRewrite(false);
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice(allowImportRewrite ? `已提交 ${files.length} 个文件的改写任务，可切换页面继续工作` : `已提交 ${files.length} 个文件的提取任务，可切换页面继续工作`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setImporting(false); }
  }

  async function generateWithAi() {
    if (!confirmDiscardPending()) return;
    if (!chatProfile) return;
    setGenerating(true);
    setError(null);
    try {
      await enqueuePlanningAiJob({
        profileId: chatProfile.id,
        mode: "GENERATE",
        sectionId: selectedId,
        sectionTitle: selectedDefinition.label,
        sectionPrompt: selectedAiPrompt,
        existingContext: existingFormalContext,
        referenceContent: "",
        userGuidance: operationGuidance,
        allowRewrite: false,
        taskKey: "workDesign",
        temperature: chatPreference.temperature ?? undefined,
        maxOutputTokens: chatPreference.maxOutputTokens ?? undefined,
      });
      setPendingAction(null);
      setStartMode(null);
      setOperationGuidance("");
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("AI 推导任务已提交，完成后会自动保存到候选区");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGenerating(false); }
  }

  async function cancelActiveJob() {
    if (!activeJob) return;
    try {
      await cancelJob(activeJob.id);
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("已请求取消 AI 任务");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function retryVisibleJob() {
    if (!visibleJob || visibleJob.status !== "FAILED" || retrying) return;
    setRetrying(true);
    setError(null);
    setNotice(null);
    setSettingMemoryNeedsRefresh(false);
    try {
      await retryJob(visibleJob.id);
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("失败任务已重新进入队列，将沿用原提示词和上下文继续执行");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRetrying(false);
    }
  }

  function restoreContent() {
    if (!previousForm) return;
    setForm(previousForm);
    setPreviousForm(null);
    setShowEditor(true);
    setNotice("已还原到操作前的内容");
  }

  function clearContent() {
    const currentContent = editorTab === "pending" ? form.pendingContent : form.content;
    if (!currentContent.trim() || !window.confirm("确定清除当前编辑内容吗？清除后仍可点击“还原”撤回。")) return;
    setPreviousForm(form);
    setForm((current) => ({ ...current, [editorTab === "pending" ? "pendingContent" : "content"]: "", references: editorTab === "pending" ? current.references : [] }));
    setShowEditor(true);
    setNotice("当前内容已清除，可以还原或重新生成");
  }

  async function confirmPending() {
    if (!form.pendingContent.trim()) return;
    const snapshot = planningDraft.beginSave();
    if (!snapshot) return;
    setError(null);
    try {
      const nextForm = {
        ...snapshot.form,
        version: snapshot.baseline.version,
        content: snapshot.form.pendingContent,
        pendingContent: "",
        storyState: snapshot.form.storyState === "LOCKED" ? "LOCKED" as const : "CONFIRMED" as const,
        references: [],
      };
      const saved = await savePlanningSection(nextForm);
      setPreviousForm(snapshot.form);
      planningDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      setEditorTab("formal");
      setShowEditor(true);
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setSettingMemoryNeedsRefresh(true);
      setNotice("已将候选确认为当前节点的正式内容");
    } catch (cause) {
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    } finally {
      planningDraft.finishSave(snapshot);
    }
  }

  function cacheSavedSection(saved: PlanningSection) {
    client.setQueryData<PlanningSection[]>(["planning-sections"], (items) =>
      [...(items ?? []).filter((item) => item.id !== saved.id), saved]);
  }

  async function refreshSettingMemory() {
    setRefreshingSettingMemory(true);
    setError(null);
    try {
      await enqueueProjectSettingSummaryRefresh();
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setSettingMemoryNeedsRefresh(false);
      setNotice("设定记忆已加入后台队列");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshingSettingMemory(false);
    }
  }

  async function savePreferences() {
    const snapshot = planningDraft.beginSave();
    if (!snapshot) return;
    setError(null);
    try {
      const saved = await savePlanningSection({
        ...snapshot.form, version: snapshot.baseline.version,
        storyState: ["UNSET", "AI_SUGGESTED"].includes(snapshot.form.storyState)
          ? snapshot.form.content.trim() ? "CONFIRMED" : snapshot.form.pendingContent.trim() ? "AI_SUGGESTED" : "UNSET"
          : snapshot.form.storyState,
        references: snapshot.form.content !== snapshot.baseline.content ? [] : snapshot.form.references,
      });
      planningDraft.acknowledge(snapshot, saved);
      cacheSavedSection(saved);
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice("本书偏好已保存");
    } catch (cause) {
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    } finally {
      planningDraft.finishSave(snapshot);
    }
  }

  if (storedSections.isPending) return <p role="status">正在读取创作准备…</p>;
  if (storedSections.isError && !storedSections.data) return <p className="project-error" role="alert">{errorMessage(storedSections.error)}</p>;

  const discussion = <PlanningSectionDiscussion sectionId={selectedId} title={selectedDefinition.label}
    question={selectedDefinition.prompt} draftContent={form.pendingContent}
    referenceContent={selectedId === "seed-tone" ? [
      form.content ? `当前笔记（可能含未保存修改）：\n${form.content}` : "",
      form.pendingContent ? `待采用内容：\n${form.pendingContent}` : "",
    ].filter(Boolean).join("\n\n") : undefined}
    disabled={!planningDraft.ready || saving || generating || importing || Boolean(activeJob)}
    readOnly={form.storyState === "LOCKED"} onBusyChange={setDiscussionBusy}
    onUseDraft={(content) => {
      setForm((current) => ({ ...current, pendingContent: content }));
      setEditorTab("pending"); setShowEditor(true); setNotice(null);
    }} />;

  if (selectedId === "seed-tone") return <section className="story-planning-workbench book-preferences-editor" aria-label="本书偏好">
    <ContentTypeLabel identity={planningSectionIdentity(selectedId)} />
    {!props.compact ? <h2>本书偏好</h2> : null}
    {discussion}
    <FreePlanningEditor draft={planningDraft} label="篇幅、风格与边界" rows={4} stateLabels={planningStoryStateLabels}
      placeholder="想写约 20 万字，大致分三卷，章节数暂不定。轻松、克制，带一点悬疑，第三人称，不写过度血腥。"
      onSave={() => void savePreferences()} onAdopt={() => void confirmPending()} />
    <PlanningDiscussionSources sectionId={selectedId} />
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {planningDraft.remoteChanged ? <div className="project-error" role="status">偏好已有新版本，本地修改仍保留。
      <button type="button" disabled={saving} onClick={() => {
        if (window.confirm("放弃本地修改并读取最新偏好吗？")) planningDraft.reload();
      }}><RotateCcw size={14} />读取最新偏好</button></div> : null}
  </section>;

  return (
    <section className="story-planning-workbench compact-work-design" aria-label="作品定位">
      <ContentTypeLabel identity={planningSectionIdentity(selectedId)} />
      <div className="story-planning-layout story-planning-layout-editor-only">
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">{selectedGroup?.label}</span><h3>{selectedDefinition.label}</h3></div>
          </div>
          {discussion}
          <div className="story-planning-action-panel">
            <div className="story-planning-action-choices">
              {editorTab === "formal" ? <button type="button" className="secondary-action" onClick={startWriting} disabled={saving}><PenLine size={15} />编辑内容</button> : null}
              <button type="button" className="secondary-action" aria-pressed={startMode === "AI"} onClick={() => { setStartMode("AI"); setPendingAction("AI"); setPendingFiles([]); setOperationGuidance(""); }} disabled={aiBusy || !chatProfile}><Sparkles size={15} />生成候选</button>
              <label className="secondary-action story-planning-import"><FileUp size={15} />提取文件<input aria-label="提取文件" type="file" accept=".txt,.md,.json" multiple disabled={aiBusy || !chatProfile} onChange={(event) => { appendImportFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label>
            </div>
            {pendingAction ? <AiModelNote compact taskLabel="作品定位" taskKey="workDesign" profile={chatProfile} preference={chatPreference} /> : null}
            {pendingAction ? <div className="story-planning-confirmation" role="status"><div className="story-planning-confirmation-summary">{pendingAction === "AI" ? <Sparkles size={16} /> : <FileUp size={16} />}<span><strong>{pendingAction === "AI" ? "确认进行 AI 推导？" : `确认提取 ${pendingFiles.length} 个文件？`}</strong><small>{pendingAction === "AI" ? `将结合已有正式设定生成“${selectedDefinition.label}”的候选内容，结果只会保存到待定区。` : allowImportRewrite ? `AI 将以所选文件为依据进行筛选、改写和合理补全，生成符合“${selectedDefinition.label}”范围的内容。` : `AI 只会严格提取所选文件中与“${selectedDefinition.label}”直接相关的原文信息，不会补写。`}</small>{pendingAction === "IMPORT" && pendingFiles.length ? <small className="story-planning-file-list">{pendingFiles.map((file) => file.name).join("、")}</small> : null}</span></div><label className="story-planning-guidance"><span>{pendingAction === "AI" ? "补充你的意见（可选）" : "补充提取要求（可选）"}</span><textarea rows={3} value={operationGuidance} onChange={(event) => setOperationGuidance(event.target.value)} placeholder={pendingAction === "AI" ? "例如：更偏现实主义，保留现有力量限制，不要加入穿越设定" : "例如：重点提取力量来源和使用代价，忽略人物外貌描写"} /></label>{pendingAction === "IMPORT" ? <label className="story-planning-rewrite-option"><input type="checkbox" checked={allowImportRewrite} onChange={(event) => setAllowImportRewrite(event.target.checked)} /><span><strong>允许 AI 改写并合理补全</strong><small>以文件内容为依据，重新组织表达并补足必要细节，使结果符合当前节点范围</small></span></label> : null}<div className="story-planning-confirmation-actions"><button type="button" className="primary-action" onClick={() => pendingAction === "AI" ? void generateWithAi() : void importSectionFile()} disabled={aiBusy || (pendingAction === "IMPORT" && !pendingFiles.length)}><Check size={14} />{pendingAction === "AI" ? "提交推导任务" : allowImportRewrite ? "提交生成改写" : "提交提取任务"}</button><button type="button" className="secondary-action" onClick={() => { setStartMode(null); setPendingAction(null); setPendingFiles([]); setOperationGuidance(""); setAllowImportRewrite(false); }} disabled={generating || importing}><X size={14} />取消</button></div></div> : null}
            {visibleJob ? <div className="story-planning-job-status" data-status={visibleJob.status.toLowerCase()}><div><strong>{visibleJob.jobType === "AI_PLANNING_EXTRACT" ? "文件处理任务" : "AI 推导任务"}</strong><span>{visibleJob.status === "QUEUED" ? "等待后台执行" : visibleJob.status === "RUNNING" ? "后台执行中，可安全切换页面" : visibleJob.status === "FAILED" ? `${visibleFailure?.label ?? "执行失败"}：${visibleJob.errorSummary ?? "未提供错误信息"} ${visibleFailure?.hint ?? ""}` : "任务已取消，可重新提交当前任务"}</span></div><div className="story-planning-job-progress"><span style={{ width: `${visibleJob.progress}%` }} /></div><small>{visibleJob.progress}%</small><div className="story-planning-job-actions"><a href="/jobs">查看任务日志</a>{activeJob ? <button type="button" onClick={() => void cancelActiveJob()}>取消任务</button> : null}{visibleJob.status === "FAILED" ? <button type="button" onClick={() => void retryVisibleJob()} disabled={retrying}><RotateCcw size={12} />{retrying ? "重试中…" : "重试原任务"}</button> : null}</div></div> : null}
          </div>
          {!chatProfile ? <p className="story-planning-ai-hint">AI 未配置。<a href="/settings#models">配置模型</a></p> : null}
          {showEditor ? <div className="story-planning-content-editor compact-plan-editor">
            <div className="creation-mode" role="group" aria-label="规划内容">
              <button type="button" aria-pressed={editorTab === "formal"} onClick={() => switchEditorTab("formal")}>正式内容</button>
              <button type="button" aria-pressed={editorTab === "pending"} onClick={() => switchEditorTab("pending")}>草稿与候选</button>
            </div>
            <textarea rows={14} readOnly={editorTab === "formal"} aria-label={editorTab === "pending" ? "规划草稿" : "正式规划"}
              value={editorTab === "pending" ? form.pendingContent : form.content}
              onChange={(event) => setForm((current) => ({ ...current, pendingContent: event.target.value }))} placeholder="尚无内容" />
            <div className="compact-plan-savebar">
              <label>内容状态<select aria-label="内容状态" value={form.storyState} onChange={(event) => setForm((current) => ({ ...current, storyState: event.target.value as PlanningStoryState }))}>
                {(Object.keys(planningStoryStateLabels) as PlanningStoryState[]).map((state) => <option key={state} value={state}
                  disabled={(state === "CONFIRMED" || state === "LOCKED") && !form.content.trim() && !form.pendingContent.trim()
                    || state === "AI_SUGGESTED" && !form.pendingContent.trim()}>{planningStoryStateLabels[state]}</option>)}</select></label>
              <div><button type="button" className="secondary-action" onClick={() => void save()} disabled={saving || !dirty}>
                <Save size={14} />{saving ? "保存中…" : editorTab === "pending" ? "保存草稿" : "保存规划"}</button>
                {editorTab === "pending" ? <button type="button" className="primary-action" onClick={() => void confirmPending()} disabled={saving || !form.pendingContent.trim()}>
                  <Check size={15} />确认为正式内容</button> : null}
              </div>
            </div>
            {previousForm || editorTab === "pending" && form.pendingContent.trim() ? <details className="compact-plan-more"><summary>更多操作</summary>
              {previousForm ? <button type="button" className="secondary-action" onClick={restoreContent}><RotateCcw size={14} />还原本次操作</button> : null}
              {editorTab === "pending" ? <button type="button" className="secondary-action destructive-action" onClick={clearContent}><Trash2 size={14} />清除草稿</button> : null}
            </details> : null}
          </div> : null}
          <p className="compact-plan-status" role="status">{sectionStatus.label}</p>
          <PlanningDiscussionSources sectionId={selectedId} />
          {notice ? <p className="project-notice story-planning-status">{notice}</p> : null}
          {settingMemoryNeedsRefresh ? <div className="story-planning-state"><strong>辅助参考 · 设定概览待更新</strong><button type="button" className="secondary-action" onClick={() => void refreshSettingMemory()} disabled={refreshingSettingMemory}>{refreshingSettingMemory ? "提交中…" : "更新设定概览"}</button></div> : null}
          {error ? <p className="project-error story-planning-status" role="alert">{error}</p> : null}
          {planningDraft.remoteChanged ? <div className="story-planning-state" role="status"><strong>此规划已有新版本，本地修改仍保留</strong><button type="button" className="secondary-action" disabled={saving} onClick={() => { if (window.confirm("放弃本地未保存修改并读取最新规划吗？")) { planningDraft.reload(); setError(null); setPreviousForm(null); setNotice("已读取最新规划"); } }}><RotateCcw size={14} />读取最新规划</button></div> : null}
        </div>
      </div>
    </section>
  );
}
