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
    id: "story-seed",
    label: "故事种子",
    children: [
      { id: "seed-premise", label: "故事前提", prompt: "如果用一句话描述这个故事，主角、目标、阻力和失败风险分别是什么" },
      { id: "seed-genre-promise", label: "类型与阅读期待", prompt: "作品属于什么类型，读者会持续获得什么样的情绪和阅读满足" },
      { id: "seed-hook", label: "独特钩子", prompt: "这个故事最独特、最值得被记住的设定或冲突是什么" },
      { id: "seed-tone", label: "基调与边界", prompt: "作品整体气质是什么，哪些表达尺度和内容边界需要长期保持" },
    ],
  },
  {
    id: "story-engine",
    label: "故事引擎",
    children: [
      { id: "engine-protagonist", label: "主角与内在缺口", prompt: "主角表面想得到什么，内心真正缺少什么，什么问题让他无法停留在原地" },
      { id: "engine-antagonism", label: "对抗力量", prompt: "谁或什么力量阻止主角，它的目标和立场为何自洽且有威胁" },
      { id: "engine-stakes", label: "赌注与代价", prompt: "成功、失败和拒绝行动分别会让主角及重要人物失去什么" },
      { id: "engine-theme", label: "主题与情感", prompt: "人物的选择将探讨什么问题，读者最终应该经历并带走什么情感" },
      { id: "engine-ending", label: "结局承诺", prompt: "结局如何回答核心戏剧问题，并兑现主线、人物和情感承诺" },
    ],
  },
  {
    id: "story-cast",
    label: "人物与关系",
    children: [
      { id: "cast-core-relationship", label: "核心关系", prompt: "哪段关系承载主要情感变化，双方彼此需要又彼此伤害什么" },
      { id: "cast-supporting", label: "关键配角", prompt: "哪些配角承担帮助、阻碍、映照、诱惑或见证功能，他们各自推动什么变化" },
      { id: "cast-arcs", label: "人物弧光", prompt: "主要人物的信念和行为如何因连续选择而改变或固化" },
    ],
  },
  {
    id: "story-frame",
    label: "世界与叙事",
    children: [
      { id: "frame-setting", label: "舞台与核心规则", prompt: "故事发生在哪里，哪些世界规则、资源限制或代价会直接影响人物行动" },
      { id: "frame-history", label: "矛盾由来", prompt: "哪些过去事件造成当前矛盾，并仍在影响人物、组织和资源分配" },
      { id: "frame-narrative", label: "视角与节奏", prompt: "由谁讲述故事，如何安排信息揭示、多线切换和整体节奏" },
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
  const selectedId = props.selectedSectionId ?? "seed-premise";
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
  const phaseDescriptions = ["先把故事说清楚", "确定冲突、赌注与结局", "让人物关系推动剧情", "补足世界规则和叙事方式"];
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
