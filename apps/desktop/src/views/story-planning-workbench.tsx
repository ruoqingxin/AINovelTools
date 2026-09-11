import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, DatabaseZap, FileUp, PenLine, RotateCcw, Save, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { classifyAiFailure } from "../lib/ai-failure";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  errorMessage,
  cancelJob,
  enqueuePlanningAiJob,
  listJobs,
  listPlanningSections,
  listModelProfiles,
  listPlanningEmbeddings,
  generatePlanningEmbedding,
  clearPlanningEmbedding,
  retryJob,
  savePlanningSection,
  type PlanningSection,
  type Job,
  type PlanningAiJobInput,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";

type PlanningItem = { id: string; label: string; prompt: string; guidance: string };
type PlanningGroup = { id: string; label: string; children: PlanningItem[] };
type PlanningStartMode = "WRITE" | "AI" | "IMPORT";

export const planningSectionGroups: PlanningGroup[] = [
  {
    id: "story-foundation",
    label: "开篇定位",
    children: [
      { id: "seed-premise", label: "核心前提与开局情境", prompt: "主角在什么异常局面中，必须完成什么高风险目标，否则会失去什么最重要的东西", guidance: "用 1—3 句话写清特殊世界或规则、突发事件、主角目标和失败后果。先回答“故事为什么现在开始”，不用展开背景百科。" },
      { id: "seed-genre-promise", label: "类型、题材与阅读承诺", prompt: "这是什么类型的故事，写给谁看，读者会持续获得什么样的满足", guidance: "写明类型、题材和主要爽点或情绪体验，并给出大致兑现频率，例如每卷一次翻盘、每 20 章一次副本收获。" },
      { id: "seed-hook", label: "核心卖点与独特钩子", prompt: "为什么读者要点开这本书，而不是同类作品", guidance: "提炼一个最独特的身份、能力、世界、关系或叙事钩子，最好浓缩成“谁利用什么，在什么世界对抗什么”的一句话。" },
      { id: "seed-tone", label: "基调、尺度与篇幅体量", prompt: "作品整体气质、表达边界、感情线位置和预计篇幅是什么", guidance: "写清热血或压抑、轻松或严肃、主角底线、感情线占比、残酷程度，以及短篇、中篇、长篇或超长篇定位。" },
    ],
  },
  {
    id: "story-engine",
    label: "故事驱动",
    children: [
      { id: "engine-protagonist", label: "主角目标与内在需求", prompt: "主角外在想完成什么，内在真正缺少或必须面对什么", guidance: "分开写外在目标和内在需求。外在目标推动情节，内在需求决定主角如何成长、改变或付出代价。" },
      { id: "engine-antagonism", label: "对抗系统与升级机制", prompt: "主角靠什么变强，资源从哪里来，强化的门槛和代价是什么，敌人如何逐层升级", guidance: "用“资源 → 获得方式 → 成长转化 → 新能力 → 新敌人或新代价”写一条链。说明为什么敌人不能直接碾压主角。" },
      { id: "engine-stakes", label: "赌注、代价与失败后果", prompt: "成功、失败和拒绝行动分别会让主角、同伴、阵营和世界失去什么", guidance: "至少写小、中、大三档赌注。失败应带来永久损失、关系破裂、身份暴露、角色死亡或规则恶化等真实后果，而不是简单重来。" },
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
  "seed-genre-promise",
  "engine-protagonist",
  "engine-antagonism",
  "engine-stakes",
  "engine-ending",
] as const;

export function nextIncompletePlanningSectionId(currentId: string, completedIds: ReadonlySet<string>) {
  const currentIndex = sections.findIndex((section) => section.id === currentId);
  const ordered = [...sections.slice(currentIndex + 1), ...sections.slice(0, Math.max(currentIndex + 1, 0))];
  return ordered.find((section) => !completedIds.has(section.id))?.id ?? null;
}

function emptySection(id: string): PlanningSection {
  return {
    id,
    content: "",
    pendingContent: "",
    rationale: "",
    consequence: "",
    references: [],
    updatedAt: "",
  };
}

function planningJobInput(job: Job): PlanningAiJobInput | null {
  if (job.jobType !== "AI_PLANNING_GENERATE" && job.jobType !== "AI_PLANNING_EXTRACT") return null;
  try {
    return JSON.parse(job.payload) as PlanningAiJobInput;
  } catch {
    return null;
  }
}

export function StoryPlanningWorkbench(props: {
  selectedSectionId?: string;
  onSelectSection?: (sectionId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const storedSections = useQuery({
    queryKey: ["planning-sections"],
    queryFn: listPlanningSections,
  });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 1200 });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const embeddings = useQuery({ queryKey: ["planning-embeddings"], queryFn: listPlanningEmbeddings });
  const selectedId = props.selectedSectionId ?? "seed-premise";
  const [form, setForm] = useState<PlanningSection>(emptySection(selectedId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const selectedGroup = planningSectionGroups.find((group) => group.children.some((item) => item.id === selectedId));
  const storedSelected = storedSections.data?.find((section) => section.id === selectedId) ?? emptySection(selectedId);
  const pendingDirty = form.pendingContent !== storedSelected.pendingContent;
  const sectionStatus = pendingDirty
    ? { label: "候选有未保存修改", hint: "点击“保存待定内容”后，修改才会保留" }
    : form.content.trim() && form.pendingContent.trim()
      ? { label: "已有正式设定 · 候选待确认", hint: "候选可以继续修改，确认后才会替换正式设定" }
      : form.content.trim()
        ? { label: "正式设定已确认", hint: "正式区只读，如需修改请转为待定内容" }
        : form.pendingContent.trim()
          ? { label: "候选已保存 · 尚未确认", hint: "可以继续修改，或设为正式设定" }
          : { label: "尚未建立", hint: "可以直接编写，或让 AI 先生成候选" };
  const dirty = form.content !== storedSelected.content
    || form.pendingContent !== storedSelected.pendingContent
    || form.rationale !== storedSelected.rationale
    || form.consequence !== storedSelected.consequence
    || JSON.stringify(form.references) !== JSON.stringify(storedSelected.references);
  const formalDirty = form.content !== storedSelected.content
    || form.rationale !== storedSelected.rationale
    || form.consequence !== storedSelected.consequence
    || JSON.stringify(form.references) !== JSON.stringify(storedSelected.references);
  const completedCount = (storedSections.data ?? []).filter((section) => sectionIds.has(section.id) && section.content.trim()).length;
  const completedIds = new Set((storedSections.data ?? []).filter((section) => section.content.trim()).map((section) => section.id));
  const selectedIndex = sections.findIndex((section) => section.id === selectedId);
  const previousSection = selectedIndex > 0 ? sections[selectedIndex - 1] : null;
  const nextSection = selectedIndex >= 0 && selectedIndex < sections.length - 1 ? sections[selectedIndex + 1] : null;
  const nextIncompleteId = nextIncompletePlanningSectionId(selectedId, completedIds);
  const nextIncompleteSection = sections.find((section) => section.id === nextIncompleteId) ?? null;
  const phaseDescriptions = ["先确定故事入口", "建立持续推进的引擎", "连载中逐步补齐"];
  const chatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "workDesign");
  const chatPreference = resolveTaskPreference(aiPreferences.data, "workDesign");
  const embeddingProfile = profiles.data?.find((profile) => profile.capability === "EMBEDDING" && profile.hasSecret);
  const currentEmbedding = embeddings.data?.find((item) => item.sectionId === selectedId);
  const embeddingState = currentEmbedding ? "已生成" : "未生成";
  const sectionJobs = (jobs.data ?? []).filter((job) => planningJobInput(job)?.sectionId === selectedId);
  const activeJob = sectionJobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const latestJob = sectionJobs[0];
  const aiBusy = generating || importing || Boolean(activeJob);
  const visibleJob = activeJob ?? (latestJob?.status === "FAILED" || latestJob?.status === "CANCELLED" ? latestJob : null);
  const visibleFailure = visibleJob?.status === "FAILED"
    ? classifyAiFailure(visibleJob.errorSummary)
    : null;
  const existingFormalContext = (storedSections.data ?? [])
    .filter((item) => sectionIds.has(item.id) && item.content.trim() && item.id !== selectedId)
    .map((item) => `${item.id}: ${item.content}`)
    .join("\n");
  const selectedAiPrompt = `当前节点“${selectedDefinition.label}”：${selectedDefinition.prompt}。填写参考：${selectedDefinition.guidance}`;
  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setError(null);
    setNotice(null);
    setShowEditor(true);
    setEditorTab(next.pendingContent.trim() ? "pending" : "formal");
    setStartMode("WRITE");
    setPendingAction(null);
    setPendingFiles([]);
    setOperationGuidance("");
    setAllowImportRewrite(false);
    setPreviousForm(null);
  }, [selectedId, storedSections.data]);

  useEffect(() => {
    if (latestJob?.status === "SUCCEEDED") {
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice("AI 内容已生成并自动保存到候选区");
    }
  }, [client, latestJob?.id, latestJob?.status]);

  useEffect(() => {
    props.onDirtyChange?.(dirty);
    return () => props.onDirtyChange?.(false);
  }, [dirty, props.onDirtyChange]);

  function selectSection(sectionId: string) {
    if (!confirmDiscardPending()) return;
    if (formalDirty && !window.confirm("当前正式设定有未保存修改，确定切换吗？")) return;
    props.onSelectSection?.(sectionId);
  }

  function confirmDiscardPending() {
    if (!pendingDirty) return true;
    if (!window.confirm("当前候选有未保存修改，确定放弃这些修改吗？")) return false;
    restoreUnsavedPending();
    return true;
  }

  function restoreUnsavedPending() {
    if (!pendingDirty) return;
    setForm((current) => ({ ...current, pendingContent: storedSelected.pendingContent }));
    setNotice("未保存的候选修改已恢复，当前显示的是上次保存的候选内容");
  }

  function switchEditorTab(tab: "formal" | "pending") {
    if (tab === editorTab) return;
    if (editorTab === "pending" && !confirmDiscardPending()) return;
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
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await savePlanningSection({
        ...form,
        id: selectedId,
      });
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      await client.invalidateQueries({ queryKey: ["planning-embeddings"] });
      setNotice(editorTab === "pending" ? "待定内容已保存" : "正式设定已保存");
      setPreviousForm(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function startWriting() {
    if (!confirmDiscardPending()) return;
    setShowEditor(true);
    setEditorTab("formal");
    setStartMode("WRITE");
    setPendingAction(null);
    setNotice("已进入编写模式，可以直接记录你的想法");
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
    setSaving(true);
    setError(null);
    try {
      const nextForm = { ...form, content: form.pendingContent, pendingContent: "", references: [] };
      const saved = await savePlanningSection(nextForm);
      setPreviousForm(form);
      setForm(saved);
      setEditorTab("formal");
      setShowEditor(true);
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice("已将候选内容设为正式设定");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function createEmbedding() {
    if (!embeddingProfile || !form.content.trim()) return;
    setError(null);
    setNotice(null);
    try {
      await generatePlanningEmbedding(embeddingProfile.id, selectedId);
      await client.invalidateQueries({ queryKey: ["planning-embeddings"] });
      setNotice("当前正式设定的向量已生成，可用于后续混合检索");
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function removeEmbedding() {
    try {
      await clearPlanningEmbedding(selectedId);
      await client.invalidateQueries({ queryKey: ["planning-embeddings"] });
      setNotice("当前节点的向量索引已清除，正式设定内容未被删除");
    } catch (cause) { setError(errorMessage(cause)); }
  }

  return (
    <section className="story-planning-workbench" aria-label="作品设定工作台">
      <div className="story-planning-titlebar">
        <div>
          <p className="eyebrow">作品设定</p>
          <h2>逐项建立小说要素</h2>
          <span className="story-planning-title-hint">每个细化节点都可以独立推导、编写或导入</span>
        </div>
        <span className="story-planning-progress">{completedCount} / {sections.length} 已完成</span>
      </div>
      <div className="planning-phase-strip" aria-label="作品设定流程">
        {planningSectionGroups.map((group, index) => {
          const complete = group.children.every((item) => completedIds.has(item.id));
          const active = selectedGroup?.id === group.id;
          const firstIncomplete = group.children.find((item) => !completedIds.has(item.id)) ?? group.children[0];
          return <button type="button" key={group.id} data-active={active || undefined} data-complete={complete || undefined} onClick={() => selectSection(firstIncomplete.id)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{group.label}</strong><small>{complete ? "已完成" : phaseDescriptions[index]}</small></button>;
        })}
      </div>
      <div className="story-planning-flowbar" aria-label="设定节点导航">
        <button type="button" className="icon-command" onClick={() => previousSection && selectSection(previousSection.id)} disabled={!previousSection} aria-label="上一项" title="上一项"><ChevronLeft size={16} /></button>
        <div><strong>{selectedIndex + 1} / {sections.length}</strong><span>{nextIncompleteSection ? `下一项建议：${nextIncompleteSection.label}` : "作品设定已全部填写"}</span></div>
        <button type="button" className="icon-command" onClick={() => nextSection && selectSection(nextSection.id)} disabled={!nextSection} aria-label="下一项" title="下一项"><ChevronRight size={16} /></button>
      </div>
      <div className="story-planning-layout story-planning-layout-editor-only">
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">{selectedGroup?.label} / 当前节点</span><h3>{selectedDefinition.label}</h3><p>{selectedDefinition.prompt}</p><div className="story-planning-fill-guide"><strong>填写提示</strong><span>{selectedDefinition.guidance}</span></div></div>
          </div>
          <div className="story-planning-action-panel">
            <div className="story-planning-action-heading"><div><strong>建立当前节点</strong><span>选择一种开始方式</span></div><small>内容确认后再保存</small></div>
            <div className="story-planning-action-choices">
              <button type="button" className="story-planning-action-choice" data-selected={startMode === "WRITE" || undefined} aria-pressed={startMode === "WRITE"} onClick={startWriting}><PenLine size={17} /><span><strong>直接编写</strong><small>从自己的想法开始</small></span></button>
              <button type="button" className="story-planning-action-choice" data-selected={startMode === "AI" || undefined} aria-pressed={startMode === "AI"} onClick={() => { setStartMode("AI"); setPendingAction("AI"); setPendingFiles([]); setOperationGuidance(""); }} disabled={aiBusy || !chatProfile}><Sparkles size={17} /><span><strong>{activeJob?.jobType === "AI_PLANNING_GENERATE" ? "正在后台推导" : "AI 推导"}</strong><small>结合已有设定生成内容</small></span></button>
              <label className="story-planning-action-choice story-planning-import" data-selected={startMode === "IMPORT" || undefined} data-disabled={aiBusy || !chatProfile || undefined}><FileUp size={17} /><span><strong>{activeJob?.jobType === "AI_PLANNING_EXTRACT" ? "正在后台处理" : pendingFiles.length ? "继续添加文件" : "AI 提取文件"}</strong><small>{pendingFiles.length ? `已选 ${pendingFiles.length} 个文件，可继续添加` : "支持同时选择多个文件"}</small></span><input type="file" accept=".txt,.md,.json" multiple disabled={aiBusy || !chatProfile} onChange={(event) => { appendImportFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label>
            </div>
            <AiModelNote taskLabel="作品设定" taskKey="workDesign" profile={chatProfile} preference={chatPreference} />
            {pendingAction ? <div className="story-planning-confirmation" role="status"><div className="story-planning-confirmation-summary">{pendingAction === "AI" ? <Sparkles size={16} /> : <FileUp size={16} />}<span><strong>{pendingAction === "AI" ? "确认进行 AI 推导？" : `确认提取 ${pendingFiles.length} 个文件？`}</strong><small>{pendingAction === "AI" ? `将结合已有正式设定生成“${selectedDefinition.label}”的候选内容，结果只会保存到待定区。` : allowImportRewrite ? `AI 将以所选文件为依据进行筛选、改写和合理补全，生成符合“${selectedDefinition.label}”范围的内容。` : `AI 只会严格提取所选文件中与“${selectedDefinition.label}”直接相关的原文信息，不会补写。`}</small>{pendingAction === "IMPORT" && pendingFiles.length ? <small className="story-planning-file-list">{pendingFiles.map((file) => file.name).join("、")}</small> : null}</span></div><label className="story-planning-guidance"><span>{pendingAction === "AI" ? "补充你的意见（可选）" : "补充提取要求（可选）"}</span><textarea rows={3} value={operationGuidance} onChange={(event) => setOperationGuidance(event.target.value)} placeholder={pendingAction === "AI" ? "例如：更偏现实主义，保留现有力量限制，不要加入穿越设定" : "例如：重点提取力量来源和使用代价，忽略人物外貌描写"} /></label>{pendingAction === "IMPORT" ? <label className="story-planning-rewrite-option"><input type="checkbox" checked={allowImportRewrite} onChange={(event) => setAllowImportRewrite(event.target.checked)} /><span><strong>允许 AI 改写并合理补全</strong><small>以文件内容为依据，重新组织表达并补足必要细节，使结果符合当前节点范围</small></span></label> : null}<div className="story-planning-confirmation-actions"><button type="button" className="primary-action" onClick={() => pendingAction === "AI" ? void generateWithAi() : void importSectionFile()} disabled={aiBusy || (pendingAction === "IMPORT" && !pendingFiles.length)}><Check size={14} />{pendingAction === "AI" ? "提交推导任务" : allowImportRewrite ? "提交生成改写" : "提交提取任务"}</button><button type="button" className="secondary-action" onClick={() => { setStartMode(null); setPendingAction(null); setPendingFiles([]); setOperationGuidance(""); setAllowImportRewrite(false); }} disabled={generating || importing}><X size={14} />取消</button></div></div> : null}
            {visibleJob ? <div className="story-planning-job-status" data-status={visibleJob.status.toLowerCase()}><div><strong>{visibleJob.jobType === "AI_PLANNING_EXTRACT" ? "文件处理任务" : "AI 推导任务"}</strong><span>{visibleJob.status === "QUEUED" ? "等待后台执行" : visibleJob.status === "RUNNING" ? "后台执行中，可安全切换页面" : visibleJob.status === "FAILED" ? `${visibleFailure?.label ?? "执行失败"}：${visibleJob.errorSummary ?? "未提供错误信息"} ${visibleFailure?.hint ?? ""}` : "任务已取消，可重新提交当前任务"}</span></div><div className="story-planning-job-progress"><span style={{ width: `${visibleJob.progress}%` }} /></div><small>{visibleJob.progress}%</small><div className="story-planning-job-actions"><a href="/jobs">查看任务日志</a>{activeJob ? <button type="button" onClick={() => void cancelActiveJob()}>取消任务</button> : null}{visibleJob.status === "FAILED" ? <button type="button" onClick={() => void retryVisibleJob()} disabled={retrying}><RotateCcw size={12} />{retrying ? "重试中…" : "重试原任务"}</button> : null}</div></div> : null}
          </div>
          {!chatProfile ? <p className="story-planning-ai-hint">请先在设置中配置一个可用的聊天模型。</p> : null}
          {showEditor ? <div className="story-planning-content-editor"><div className="story-planning-content-tabs" role="tablist" aria-label="设定内容区域"><button type="button" role="tab" aria-selected={editorTab === "formal"} data-active={editorTab === "formal" || undefined} onClick={() => switchEditorTab("formal")}><span>正式设定</span><small>{form.content.trim() ? "已建立" : "未填写"}</small></button><button type="button" role="tab" aria-selected={editorTab === "pending"} data-active={editorTab === "pending" || undefined} onClick={() => switchEditorTab("pending")}><span>待定区</span><small>{form.pendingContent.trim() ? "有候选内容" : "暂无内容"}</small></button></div><label><span>{editorTab === "pending" ? "待定内容" : "正式设定"}</span><small>{editorTab === "pending" ? "AI 生成后会自动保存；手动修改后需点击“保存待定内容”，否则切换操作会恢复到已保存版本" : "正式设定只读。如需修改，请先转为待定内容，修改后再设为正式设定"}</small><textarea rows={12} autoFocus readOnly={editorTab === "formal"} value={editorTab === "pending" ? form.pendingContent : form.content} onChange={(event) => setForm((current) => ({ ...current, pendingContent: event.target.value }))} placeholder={editorTab === "pending" ? `等待生成或填写${selectedDefinition.label}的候选内容…` : `尚未建立${selectedDefinition.label}…`} /></label><div className="story-planning-actions">{editorTab === "pending" ? <><button type="button" className="primary-action" onClick={() => void confirmPending()} disabled={saving || !form.pendingContent.trim()}><Check size={15} />{saving ? "同步中…" : "设为正式设定"}</button><button type="button" className="secondary-action" onClick={() => void save()} disabled={saving || !pendingDirty}><Save size={14} />保存待定内容</button></> : <><button type="button" className="primary-action" onClick={() => { setForm((current) => ({ ...current, pendingContent: current.content })); setEditorTab("pending"); setNotice("已转为待定内容，请修改后保存"); }} disabled={!form.content.trim()}>转为待定内容</button><button type="button" className="secondary-action" onClick={() => void createEmbedding()} disabled={!form.content.trim() || !embeddingProfile}><DatabaseZap size={14} />{embeddingState === "已生成" ? "重新生成向量" : "生成向量"}</button><button type="button" className="secondary-action destructive-action" onClick={() => void removeEmbedding()} disabled={!currentEmbedding}><Trash2 size={14} />清除向量</button></>}{previousForm ? <button type="button" className="secondary-action" onClick={restoreContent}><RotateCcw size={14} />还原本次操作</button> : null}{editorTab === "pending" ? <button type="button" className="secondary-action destructive-action" onClick={clearContent} disabled={!form.pendingContent.trim()}><Trash2 size={14} />清除内容</button> : null}</div><div className="story-planning-state"><strong>向量状态：{embeddingState}</strong><span>{!embeddingProfile ? "请先配置带密钥的 Embedding 模型" : "正式设定优先复用持久向量，文件片段在任务执行时临时向量化，用于混合检索"}</span></div></div> : null}
          <div className="story-planning-state" data-dirty={pendingDirty || undefined}><strong>{sectionStatus.label}</strong><span>{sectionStatus.hint}</span></div>
          {notice ? <p className="project-notice story-planning-status">{notice}</p> : null}
          {error ? <p className="project-error story-planning-status" role="alert">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
