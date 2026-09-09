import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, FileUp, PenLine, RotateCcw, Save, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  errorMessage,
  cancelJob,
  enqueuePlanningAiJob,
  listJobs,
  listPlanningSections,
  listModelProfiles,
  savePlanningSection,
  type PlanningSection,
  type Job,
  type PlanningAiJobInput,
} from "../lib/tauri-client";

type PlanningItem = { id: string; label: string; prompt: string };
type PlanningGroup = { id: string; label: string; children: PlanningItem[] };
type PlanningStartMode = "WRITE" | "AI" | "IMPORT";

export const planningSectionGroups: PlanningGroup[] = [
  {
    id: "creative-positioning",
    label: "作品定位",
    children: [
      { id: "positioning-genre", label: "类型与题材", prompt: "作品的主类型、辅助类型和核心题材元素分别是什么" },
      { id: "positioning-promise", label: "读者与阅读承诺", prompt: "作品主要写给谁，承诺持续提供怎样的情绪和类型满足" },
      { id: "positioning-selling-point", label: "核心卖点", prompt: "与同类作品相比，最值得读者记住的独特吸引力是什么" },
      { id: "positioning-tone", label: "基调与尺度", prompt: "作品的整体气质、内容尺度和不会越过的表达边界是什么" },
      { id: "positioning-scale", label: "篇幅与体量", prompt: "预计采用怎样的篇幅、时间跨度、空间范围和叙事规模" },
    ],
  },
  {
    id: "story-core",
    label: "故事内核",
    children: [
      { id: "core-premise", label: "一句话梗概", prompt: "用主角、目标、阻力和失败风险准确概括整个故事" },
      { id: "core-situation", label: "核心情境", prompt: "哪个具有持续张力的特殊处境让这个故事值得展开" },
      { id: "core-theme", label: "主题命题", prompt: "作品借人物的选择探讨什么问题，不同人物代表哪些答案" },
      { id: "core-dramatic-question", label: "核心戏剧问题", prompt: "读者会持续追问哪个贯穿全书、直到结局才真正回答的问题" },
      { id: "core-emotion", label: "情感内核", prompt: "作品最想让读者经历和带走的核心情感是什么" },
      { id: "core-ending", label: "结局落点", prompt: "故事最终如何回答戏剧问题，并兑现主题、人物和情感承诺" },
    ],
  },
  {
    id: "character-system",
    label: "人物系统",
    children: [
      { id: "character-motivation", label: "主角目标与需求", prompt: "主角外在想达成什么，内在真正需要面对或获得什么" },
      { id: "character-flaw", label: "主角缺陷与困境", prompt: "什么认知、创伤、欲望或处境让主角不断作出困难选择" },
      { id: "character-antagonist", label: "对抗者", prompt: "谁或什么力量与主角争夺同一结果，其立场为何自洽且有威胁" },
      { id: "character-relationship", label: "核心关系", prompt: "哪段关系承载主要情感变化，双方彼此需要又彼此伤害什么" },
      { id: "character-supporting", label: "关键配角", prompt: "配角分别承担帮助、阻碍、映照、诱惑或见证中的什么功能" },
      { id: "character-arcs", label: "人物弧光", prompt: "主要人物的信念和行为如何因连续选择而改变或固化" },
      { id: "character-secrets", label: "秘密与信息差", prompt: "谁隐瞒了什么，真相揭露时会改变什么" },
    ],
  },
  {
    id: "story-world",
    label: "故事世界",
    children: [
      { id: "world-stage", label: "时空舞台", prompt: "故事发生在怎样的时代与地域，环境如何直接影响人物行动" },
      { id: "world-rules", label: "核心规则", prompt: "哪些不可随意打破的规则决定了人物能做什么、不能做什么" },
      { id: "world-history", label: "历史与现状", prompt: "哪些过去事件造成当前矛盾，并仍在影响人物和势力" },
      { id: "world-power", label: "力量、技术与代价", prompt: "特殊能力或技术如何获得和使用，其限制、代价与反制是什么" },
      { id: "world-society", label: "权力与社会运行", prompt: "组织、阶层、法律和资源如何分配权力并制造现实阻力" },
      { id: "world-culture", label: "文化与日常生活", prompt: "信仰、习俗、禁忌和生活方式如何进入人物选择与具体场景" },
    ],
  },
  {
    id: "plot-system",
    label: "情节系统",
    children: [
      { id: "plot-opening", label: "开局状态", prompt: "故事开始时主角处于怎样的常态，潜在矛盾为何已无法长久维持" },
      { id: "plot-trigger", label: "触发事件", prompt: "什么事件打破现状，迫使主角卷入故事并作出选择" },
      { id: "plot-goal", label: "主线目标", prompt: "主角采取什么持续行动追求哪个可以明确判断成败的结果" },
      { id: "plot-obstacles", label: "阻力系统", prompt: "外部对抗、环境限制和主角自身问题如何共同阻止目标实现" },
      { id: "plot-stakes", label: "赌注与代价", prompt: "成功、失败和拒绝行动分别会让主角及相关人物失去什么" },
      { id: "plot-escalation", label: "升级与转折", prompt: "新信息、失败和选择如何改变局势，使后续行动越来越困难" },
      { id: "plot-climax", label: "高潮抉择", prompt: "最终对抗将迫使主角作出什么不可回避、能够证明人物变化的选择" },
    ],
  },
  {
    id: "narrative-strategy",
    label: "叙事方案",
    children: [
      { id: "narrative-perspective", label: "视角与叙述距离", prompt: "由谁感知和讲述故事，叙述贴近人物到什么程度，有哪些盲区" },
      { id: "narrative-time", label: "时间与结构", prompt: "故事如何安排时间顺序、多线切换和章节结构以获得最佳效果" },
      { id: "narrative-information", label: "信息与悬念", prompt: "角色和读者分别在何时知道什么，真相如何铺垫、误导与揭示" },
      { id: "narrative-rhythm", label: "节奏曲线", prompt: "紧张、舒缓、信息、行动和情感段落如何形成整体起伏" },
      { id: "narrative-style", label: "文风与语言", prompt: "叙述语言、描写密度、对话气质和需要长期保持的表达规范是什么" },
      { id: "narrative-motifs", label: "意象与母题", prompt: "哪些反复出现的意象、场景或动作能够强化主题与情感" },
    ],
  },
];
const sections = planningSectionGroups.flatMap((group) => group.children);
const sectionIds = new Set(sections.map((section) => section.id));
export const essentialPlanningSectionIds = [
  "positioning-genre",
  "positioning-promise",
  "core-premise",
  "plot-goal",
  "plot-stakes",
  "core-ending",
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
  const selectedId = props.selectedSectionId ?? "positioning-genre";
  const [form, setForm] = useState<PlanningSection>(emptySection(selectedId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<"formal" | "pending">("formal");
  const [showEditor, setShowEditor] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [startMode, setStartMode] = useState<PlanningStartMode | null>(null);
  const [pendingAction, setPendingAction] = useState<"AI" | "IMPORT" | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [operationGuidance, setOperationGuidance] = useState("");
  const [allowImportRewrite, setAllowImportRewrite] = useState(false);
  const [previousForm, setPreviousForm] = useState<PlanningSection | null>(null);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const selectedGroup = planningSectionGroups.find((group) => group.children.some((item) => item.id === selectedId));
  const storedSelected = storedSections.data?.find((section) => section.id === selectedId) ?? emptySection(selectedId);
  const dirty = form.content !== storedSelected.content
    || form.pendingContent !== storedSelected.pendingContent
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
  const chatProfile = profiles.data?.find((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const sectionJobs = (jobs.data ?? []).filter((job) => planningJobInput(job)?.sectionId === selectedId);
  const activeJob = sectionJobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const latestJob = sectionJobs[0];
  const aiBusy = generating || importing || Boolean(activeJob);
  const visibleJob = activeJob ?? (latestJob?.status === "FAILED" || latestJob?.status === "CANCELLED" ? latestJob : null);
  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setError(null);
    setNotice(null);
    setShowEditor(Boolean(next.content.trim() || next.pendingContent.trim()));
    setEditorTab(next.pendingContent.trim() ? "pending" : "formal");
    setStartMode(null);
    setPendingAction(null);
    setPendingFiles([]);
    setOperationGuidance("");
    setAllowImportRewrite(false);
    setPreviousForm(null);
  }, [selectedId, storedSections.data]);

  useEffect(() => {
    if (latestJob?.status === "SUCCEEDED") void client.invalidateQueries({ queryKey: ["planning-sections"] });
  }, [client, latestJob?.id, latestJob?.status]);

  useEffect(() => {
    props.onDirtyChange?.(dirty);
    return () => props.onDirtyChange?.(false);
  }, [dirty, props.onDirtyChange]);

  function selectSection(sectionId: string) {
    if (dirty && !window.confirm("当前设定有未保存修改，确定切换吗？")) return;
    props.onSelectSection?.(sectionId);
  }

  async function save(advance = false) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await savePlanningSection({
        ...form,
        id: selectedId,
      });
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice(editorTab === "pending" ? "待定内容已保存" : "正式设定已保存");
      setPreviousForm(null);
      if (advance) {
        const nextId = nextIncompletePlanningSectionId(selectedId, new Set([...completedIds, ...(form.content.trim() ? [selectedId] : [])]));
        if (nextId) props.onSelectSection?.(nextId);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function startWriting() {
    setShowEditor(true);
    setEditorTab("formal");
    setStartMode("WRITE");
    setPendingAction(null);
    setNotice("已进入编写模式，可以直接记录你的想法");
  }

  async function importSectionFile() {
    const files = pendingFiles;
    if (!files.length) return;
    if (!chatProfile) { setError("请先在设置中配置一个可用的聊天模型"); return; }
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const content = (await Promise.all(files.map(async (file) => `===== 文件：${file.name} =====\n${await file.text()}`))).join("\n\n");
      await enqueuePlanningAiJob({ profileId: chatProfile.id, mode: "EXTRACT", sectionId: selectedId, sectionTitle: selectedDefinition.label, sectionPrompt: selectedDefinition.prompt, existingContext: "", referenceContent: content, userGuidance: operationGuidance, allowRewrite: allowImportRewrite, sourceName: files.map((file) => file.name) });
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
    if (!chatProfile) return;
    setGenerating(true);
    setError(null);
    try {
      const existing = (storedSections.data ?? [])
        .filter((item) => sectionIds.has(item.id) && item.content.trim())
        .map((item) => `${item.id}: ${item.content}`)
        .join("\n");
      await enqueuePlanningAiJob({
        profileId: chatProfile.id,
        mode: "GENERATE",
        sectionId: selectedId,
        sectionTitle: selectedDefinition.label,
        sectionPrompt: selectedDefinition.prompt,
        existingContext: existing,
        referenceContent: "",
        userGuidance: operationGuidance,
        allowRewrite: false,
      });
      setPendingAction(null);
      setStartMode(null);
      setOperationGuidance("");
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("AI 推导任务已提交，可切换页面继续工作");
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

  async function confirmPending(advance = false) {
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
      setNotice("待定内容已同步并保存为正式设定");
      if (advance) {
        const nextId = nextIncompletePlanningSectionId(selectedId, new Set([...completedIds, selectedId]));
        if (nextId) props.onSelectSection?.(nextId);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="story-planning-workbench" aria-label="作品设定工作台">
      <div className="story-planning-titlebar">
        <div>
          <p className="eyebrow">作品设计</p>
          <h2>逐项建立小说要素</h2>
          <span className="story-planning-title-hint">每个细化节点都可以独立推导、编写或导入</span>
        </div>
        <span className="story-planning-progress">{completedCount} / {sections.length} 已完成</span>
      </div>
      <div className="story-planning-flowbar" aria-label="设定节点导航">
        <button type="button" className="icon-command" onClick={() => previousSection && selectSection(previousSection.id)} disabled={!previousSection} aria-label="上一项" title="上一项"><ChevronLeft size={16} /></button>
        <div><strong>{selectedIndex + 1} / {sections.length}</strong><span>{nextIncompleteSection ? `下一项建议：${nextIncompleteSection.label}` : "作品设定已全部填写"}</span></div>
        <button type="button" className="icon-command" onClick={() => nextSection && selectSection(nextSection.id)} disabled={!nextSection} aria-label="下一项" title="下一项"><ChevronRight size={16} /></button>
      </div>
      <div className="story-planning-layout story-planning-layout-editor-only">
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">{selectedGroup?.label} / 当前节点</span><h3>{selectedDefinition.label}</h3><p>{selectedDefinition.prompt}</p></div>
          </div>
          <div className="story-planning-action-panel">
            <div className="story-planning-action-heading"><div><strong>建立当前节点</strong><span>选择一种开始方式</span></div><small>内容确认后再保存</small></div>
            <div className="story-planning-action-choices">
              <button type="button" className="story-planning-action-choice" data-selected={startMode === "WRITE" || undefined} aria-pressed={startMode === "WRITE"} onClick={startWriting}><PenLine size={17} /><span><strong>直接编写</strong><small>从自己的想法开始</small></span></button>
              <button type="button" className="story-planning-action-choice" data-selected={startMode === "AI" || undefined} aria-pressed={startMode === "AI"} onClick={() => { setStartMode("AI"); setPendingAction("AI"); setPendingFiles([]); setOperationGuidance(""); }} disabled={aiBusy || !chatProfile}><Sparkles size={17} /><span><strong>{activeJob?.jobType === "AI_PLANNING_GENERATE" ? "正在后台推导" : "AI 推导"}</strong><small>结合已有设定生成内容</small></span></button>
              <label className="story-planning-action-choice story-planning-import" data-selected={startMode === "IMPORT" || undefined} data-disabled={aiBusy || !chatProfile || undefined}><FileUp size={17} /><span><strong>{activeJob?.jobType === "AI_PLANNING_EXTRACT" ? "正在后台处理" : "AI 提取文件"}</strong><small>支持同时选择多个文件</small></span><input type="file" accept=".txt,.md,.json" multiple disabled={aiBusy || !chatProfile} onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) { setStartMode("IMPORT"); setPendingFiles(files); setPendingAction("IMPORT"); setOperationGuidance(""); setAllowImportRewrite(false); } event.currentTarget.value = ""; }} /></label>
            </div>
            {pendingAction ? <div className="story-planning-confirmation" role="status"><div className="story-planning-confirmation-summary">{pendingAction === "AI" ? <Sparkles size={16} /> : <FileUp size={16} />}<span><strong>{pendingAction === "AI" ? "确认进行 AI 推导？" : `确认提取 ${pendingFiles.length} 个文件？`}</strong><small>{pendingAction === "AI" ? `将结合已有正式设定生成“${selectedDefinition.label}”的候选内容，结果只会保存到待定区。` : allowImportRewrite ? `AI 将以所选文件为依据进行筛选、改写和合理补全，生成符合“${selectedDefinition.label}”范围的内容。` : `AI 只会严格提取所选文件中与“${selectedDefinition.label}”直接相关的原文信息，不会补写。`}</small>{pendingAction === "IMPORT" && pendingFiles.length ? <small className="story-planning-file-list">{pendingFiles.map((file) => file.name).join("、")}</small> : null}</span></div><label className="story-planning-guidance"><span>{pendingAction === "AI" ? "补充你的意见（可选）" : "补充提取要求（可选）"}</span><textarea rows={3} value={operationGuidance} onChange={(event) => setOperationGuidance(event.target.value)} placeholder={pendingAction === "AI" ? "例如：更偏现实主义，保留现有力量限制，不要加入穿越设定" : "例如：重点提取力量来源和使用代价，忽略人物外貌描写"} /></label>{pendingAction === "IMPORT" ? <label className="story-planning-rewrite-option"><input type="checkbox" checked={allowImportRewrite} onChange={(event) => setAllowImportRewrite(event.target.checked)} /><span><strong>允许 AI 改写并合理补全</strong><small>以文件内容为依据，重新组织表达并补足必要细节，使结果符合当前节点范围</small></span></label> : null}<div className="story-planning-confirmation-actions"><button type="button" className="primary-action" onClick={() => pendingAction === "AI" ? void generateWithAi() : void importSectionFile()} disabled={aiBusy || (pendingAction === "IMPORT" && !pendingFiles.length)}><Check size={14} />{pendingAction === "AI" ? "提交推导任务" : allowImportRewrite ? "提交生成改写" : "提交提取任务"}</button><button type="button" className="secondary-action" onClick={() => { setStartMode(null); setPendingAction(null); setPendingFiles([]); setOperationGuidance(""); setAllowImportRewrite(false); }} disabled={generating || importing}><X size={14} />取消</button></div></div> : null}
            {visibleJob ? <div className="story-planning-job-status" data-status={visibleJob.status.toLowerCase()}><div><strong>{visibleJob.jobType === "AI_PLANNING_EXTRACT" ? "文件处理任务" : "AI 推导任务"}</strong><span>{visibleJob.status === "QUEUED" ? "等待后台执行" : visibleJob.status === "RUNNING" ? "后台执行中，可安全切换页面" : visibleJob.status === "FAILED" ? visibleJob.errorSummary ?? "执行失败" : "任务已取消"}</span></div><div className="story-planning-job-progress"><span style={{ width: `${visibleJob.progress}%` }} /></div><small>{visibleJob.progress}%</small><div className="story-planning-job-actions"><a href="/jobs">查看任务日志</a>{activeJob ? <button type="button" onClick={() => void cancelActiveJob()}>取消任务</button> : null}</div></div> : null}
          </div>
          {!chatProfile ? <p className="story-planning-ai-hint">请先在设置中配置一个可用的聊天模型。</p> : null}
          {showEditor ? <div className="story-planning-content-editor"><div className="story-planning-content-tabs" role="tablist" aria-label="设定内容区域"><button type="button" role="tab" aria-selected={editorTab === "formal"} data-active={editorTab === "formal" || undefined} onClick={() => setEditorTab("formal")}><span>正式设定</span><small>{form.content.trim() ? "已建立" : "未填写"}</small></button><button type="button" role="tab" aria-selected={editorTab === "pending"} data-active={editorTab === "pending" || undefined} onClick={() => setEditorTab("pending")}><span>待定区</span><small>{form.pendingContent.trim() ? "有候选内容" : "暂无内容"}</small></button></div><label><span>{editorTab === "pending" ? "待定内容" : "正式设定"}</span><small>{editorTab === "pending" ? "AI 推导和文件提取的结果先保存在这里，可修改、对比后再确认采用" : "当前正式生效的设定内容，直接编写也会保存在这里"}</small><textarea rows={12} autoFocus value={editorTab === "pending" ? form.pendingContent : form.content} onChange={(event) => setForm((current) => ({ ...current, [editorTab === "pending" ? "pendingContent" : "content"]: event.target.value }))} placeholder={editorTab === "pending" ? `等待生成或填写${selectedDefinition.label}的候选内容…` : `填写${selectedDefinition.label}…`} /></label><div className="story-planning-actions">{editorTab === "pending" ? <><button type="button" className="primary-action" onClick={() => void confirmPending(true)} disabled={saving || !form.pendingContent.trim()}><Check size={15} />{saving ? "同步中…" : "采用并继续"}</button><button type="button" className="secondary-action" onClick={() => void confirmPending()} disabled={saving || !form.pendingContent.trim()}>仅确认采用</button><button type="button" className="secondary-action" onClick={() => void save()} disabled={saving || !form.pendingContent.trim()}><Save size={14} />保存待定内容</button></> : <><button type="button" className="primary-action" onClick={() => void save(true)} disabled={saving || !form.content.trim()}><Save size={15} />{saving ? "保存中…" : "保存并继续"}</button><button type="button" className="secondary-action" onClick={() => void save()} disabled={saving || !form.content.trim()}>仅保存</button></>}<button type="button" className="secondary-action" onClick={restoreContent} disabled={!previousForm}><RotateCcw size={14} />还原</button><button type="button" className="secondary-action destructive-action" onClick={clearContent} disabled={!(editorTab === "pending" ? form.pendingContent : form.content).trim()}><Trash2 size={14} />清除内容</button></div></div> : null}
          {notice ? <p className="project-notice story-planning-status">{notice}</p> : null}
          {error ? <p className="project-error story-planning-status" role="alert">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
