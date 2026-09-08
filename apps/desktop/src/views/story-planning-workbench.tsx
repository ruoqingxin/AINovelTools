import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileUp, PenLine, RotateCcw, Save, Sparkles, Trash2, X } from "lucide-react";
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

export const planningSectionGroups: PlanningGroup[] = [
  { id: "story-core", label: "故事核心", children: [{ id: "story-theme", label: "主题与题材", prompt: "这部小说想讨论什么" }, { id: "story-protagonist", label: "主角与欲望", prompt: "主角想得到什么" }, { id: "story-conflict", label: "核心冲突", prompt: "什么力量阻碍主角" }] },
  { id: "world-foundation", label: "世界基础", children: [{ id: "world-origin", label: "起源", prompt: "世界从何而来" }, { id: "world-rules", label: "规则", prompt: "世界如何运行" }, { id: "world-space", label: "空间", prompt: "故事发生在哪里" }, { id: "world-geography", label: "地理", prompt: "地点如何分布和连接" }, { id: "world-resources", label: "资源", prompt: "什么稀缺、谁掌握它" }] },
  { id: "civilization", label: "文明社会", children: [{ id: "society-species", label: "种族与群体", prompt: "谁生活在这个世界" }, { id: "society-power", label: "力量体系", prompt: "力量从哪里来" }, { id: "society-production", label: "生产方式", prompt: "社会如何生产和交换" }, { id: "society-economy", label: "经济", prompt: "财富如何流动" }, { id: "society-class", label: "阶级关系", prompt: "谁获得机会、谁被排除" }] },
  { id: "politics-culture", label: "政治文化", children: [{ id: "politics-factions", label: "势力", prompt: "谁在争夺决定权" }, { id: "politics-system", label: "制度", prompt: "权力如何被组织" }, { id: "politics-history", label: "历史", prompt: "过去留下了什么" }, { id: "politics-belief", label: "信仰", prompt: "人们相信什么" }, { id: "politics-custom", label: "习俗", prompt: "人们如何生活和表达" }] },
  { id: "story-engine", label: "故事发动机", children: [{ id: "engine-situation", label: "当前局势", prompt: "故事从什么失衡状态开始" }, { id: "engine-goal", label: "阶段目标", prompt: "主角下一步要完成什么" }, { id: "engine-antagonist", label: "反派与阻力", prompt: "谁会持续制造代价" }, { id: "engine-time", label: "时间压力", prompt: "为什么必须现在行动" }] },
] ;
const sections = planningSectionGroups.flatMap((group) => group.children);
const legacySectionByChild: Record<string, string> = {
  "story-theme": "story-core",
  "world-origin": "world-foundation",
  "society-species": "civilization",
  "politics-factions": "politics-culture",
  "engine-situation": "story-engine",
};
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
}) {
  const client = useQueryClient();
  const storedSections = useQuery({
    queryKey: ["planning-sections"],
    queryFn: listPlanningSections,
  });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 1200 });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const selectedId = props.selectedSectionId ?? "story-theme";
  const [form, setForm] = useState<PlanningSection>(emptySection(selectedId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<"formal" | "pending">("formal");
  const [showEditor, setShowEditor] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingAction, setPendingAction] = useState<"AI" | "IMPORT" | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [operationGuidance, setOperationGuidance] = useState("");
  const [allowImportRewrite, setAllowImportRewrite] = useState(false);
  const [previousForm, setPreviousForm] = useState<PlanningSection | null>(null);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const selectedGroup = planningSectionGroups.find((group) => group.children.some((item) => item.id === selectedId));
  const completedCount = (storedSections.data ?? []).filter((section) => section.content.trim()).length;
  const chatProfile = profiles.data?.find((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const sectionJobs = (jobs.data ?? []).filter((job) => planningJobInput(job)?.sectionId === selectedId);
  const activeJob = sectionJobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const latestJob = sectionJobs[0];
  const aiBusy = generating || importing || Boolean(activeJob);
  const visibleJob = activeJob ?? (latestJob?.status === "FAILED" || latestJob?.status === "CANCELLED" ? latestJob : null);
  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId) ?? (legacySectionByChild[selectedId] ? storedSections.data?.find((section) => section.id === legacySectionByChild[selectedId]) : undefined);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setError(null);
    setNotice(null);
    setShowEditor(Boolean(next.content.trim() || next.pendingContent.trim()));
    setEditorTab(next.pendingContent.trim() ? "pending" : "formal");
    setPendingAction(null);
    setPendingFile(null);
    setOperationGuidance("");
    setAllowImportRewrite(false);
    setPreviousForm(null);
  }, [selectedId, storedSections.data]);

  useEffect(() => {
    if (latestJob?.status === "SUCCEEDED") void client.invalidateQueries({ queryKey: ["planning-sections"] });
  }, [client, latestJob?.id, latestJob?.status]);

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
      setNotice(editorTab === "pending" ? "待定内容已保存" : "正式设定已保存");
      setPreviousForm(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function startWriting() {
    setShowEditor(true);
    setEditorTab("formal");
    setPendingAction(null);
    setNotice("已进入编写模式，可以直接记录你的想法");
  }

  async function importSectionFile() {
    const file = pendingFile;
    if (!file) return;
    if (!chatProfile) { setError("请先在设置中配置一个可用的聊天模型"); return; }
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const content = await file.text();
      await enqueuePlanningAiJob({ profileId: chatProfile.id, mode: "EXTRACT", sectionId: selectedId, sectionTitle: selectedDefinition.label, sectionPrompt: selectedDefinition.prompt, existingContext: "", referenceContent: content, userGuidance: operationGuidance, allowRewrite: allowImportRewrite, sourceName: file.name });
      setPendingAction(null);
      setPendingFile(null);
      setOperationGuidance("");
      setAllowImportRewrite(false);
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice(allowImportRewrite ? `已提交“${file.name}”改写任务，可切换页面继续工作` : `已提交“${file.name}”提取任务，可切换页面继续工作`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setImporting(false); }
  }

  async function generateWithAi() {
    if (!chatProfile) return;
    setGenerating(true);
    setError(null);
    try {
      const existing = (storedSections.data ?? []).map((item) => `${item.id}: ${item.content}`).filter(Boolean).join("\n");
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
      setNotice("待定内容已同步并保存为正式设定");
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
      <div className="story-planning-layout story-planning-layout-editor-only">
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">{selectedGroup?.label} / 当前节点</span><h3>{selectedDefinition.label}</h3><p>{selectedDefinition.prompt}</p></div>
          </div>
          <div className="story-planning-action-panel">
            <div className="story-planning-action-heading"><div><strong>建立当前节点</strong><span>选择一种开始方式</span></div><small>内容确认后再保存</small></div>
            <div className="story-planning-action-choices">
              <button type="button" className="story-planning-action-choice action-choice-primary" onClick={startWriting}><PenLine size={17} /><span><strong>直接编写</strong><small>从自己的想法开始</small></span></button>
              <button type="button" className="story-planning-action-choice" onClick={() => { setPendingAction("AI"); setPendingFile(null); setOperationGuidance(""); }} disabled={aiBusy || !chatProfile}><Sparkles size={17} /><span><strong>{activeJob?.jobType === "AI_PLANNING_GENERATE" ? "正在后台推导" : "AI 推导"}</strong><small>结合已有设定生成内容</small></span></button>
              <label className="story-planning-action-choice story-planning-import" data-disabled={aiBusy || !chatProfile || undefined}><FileUp size={17} /><span><strong>{activeJob?.jobType === "AI_PLANNING_EXTRACT" ? "正在后台处理" : "AI 提取文件"}</strong><small>仅保留符合当前节点的内容</small></span><input type="file" accept=".txt,.md,.json" disabled={aiBusy || !chatProfile} onChange={(event) => { const file = event.target.files?.[0]; if (file) { setPendingFile(file); setPendingAction("IMPORT"); setOperationGuidance(""); setAllowImportRewrite(false); } event.currentTarget.value = ""; }} /></label>
            </div>
            {pendingAction ? <div className="story-planning-confirmation" role="status"><div className="story-planning-confirmation-summary">{pendingAction === "AI" ? <Sparkles size={16} /> : <FileUp size={16} />}<span><strong>{pendingAction === "AI" ? "确认进行 AI 推导？" : `确认提取“${pendingFile?.name ?? "所选文件"}”？`}</strong><small>{pendingAction === "AI" ? `将结合已有正式设定生成“${selectedDefinition.label}”的候选内容，结果只会保存到待定区。` : allowImportRewrite ? `AI 将以文件为依据进行筛选、改写和合理补全，生成符合“${selectedDefinition.label}”范围的内容。` : `AI 只会严格提取与“${selectedDefinition.label}”直接相关的原文信息，不会补写。`}</small></span></div><label className="story-planning-guidance"><span>{pendingAction === "AI" ? "补充你的意见（可选）" : "补充提取要求（可选）"}</span><textarea rows={3} value={operationGuidance} onChange={(event) => setOperationGuidance(event.target.value)} placeholder={pendingAction === "AI" ? "例如：更偏现实主义，保留现有力量限制，不要加入穿越设定" : "例如：重点提取力量来源和使用代价，忽略人物外貌描写"} /></label>{pendingAction === "IMPORT" ? <label className="story-planning-rewrite-option"><input type="checkbox" checked={allowImportRewrite} onChange={(event) => setAllowImportRewrite(event.target.checked)} /><span><strong>允许 AI 改写并合理补全</strong><small>以文件内容为依据，重新组织表达并补足必要细节，使结果符合当前节点范围</small></span></label> : null}<div className="story-planning-confirmation-actions"><button type="button" className="primary-action" onClick={() => pendingAction === "AI" ? void generateWithAi() : void importSectionFile()} disabled={aiBusy || (pendingAction === "IMPORT" && !pendingFile)}><Check size={14} />{pendingAction === "AI" ? "提交推导任务" : allowImportRewrite ? "提交生成改写" : "提交提取任务"}</button><button type="button" className="secondary-action" onClick={() => { setPendingAction(null); setPendingFile(null); setOperationGuidance(""); setAllowImportRewrite(false); }} disabled={generating || importing}><X size={14} />取消</button></div></div> : null}
            {visibleJob ? <div className="story-planning-job-status" data-status={visibleJob.status.toLowerCase()}><div><strong>{visibleJob.jobType === "AI_PLANNING_EXTRACT" ? "文件处理任务" : "AI 推导任务"}</strong><span>{visibleJob.status === "QUEUED" ? "等待后台执行" : visibleJob.status === "RUNNING" ? "后台执行中，可安全切换页面" : visibleJob.status === "FAILED" ? visibleJob.errorSummary ?? "执行失败" : "任务已取消"}</span></div><div className="story-planning-job-progress"><span style={{ width: `${visibleJob.progress}%` }} /></div><small>{visibleJob.progress}%</small><div className="story-planning-job-actions"><a href="/jobs">查看任务日志</a>{activeJob ? <button type="button" onClick={() => void cancelActiveJob()}>取消任务</button> : null}</div></div> : null}
          </div>
          {!chatProfile ? <p className="story-planning-ai-hint">请先在设置中配置一个可用的聊天模型。</p> : null}
          {showEditor ? <div className="story-planning-content-editor"><div className="story-planning-content-tabs" role="tablist" aria-label="设定内容区域"><button type="button" role="tab" aria-selected={editorTab === "formal"} data-active={editorTab === "formal" || undefined} onClick={() => setEditorTab("formal")}><span>正式设定</span><small>{form.content.trim() ? "已建立" : "未填写"}</small></button><button type="button" role="tab" aria-selected={editorTab === "pending"} data-active={editorTab === "pending" || undefined} onClick={() => setEditorTab("pending")}><span>待定区</span><small>{form.pendingContent.trim() ? "有候选内容" : "暂无内容"}</small></button></div><label><span>{editorTab === "pending" ? "待定内容" : "正式设定"}</span><small>{editorTab === "pending" ? "AI 推导和文件提取的结果先保存在这里，可修改、对比后再确认采用" : "当前正式生效的设定内容，直接编写也会保存在这里"}</small><textarea rows={12} autoFocus value={editorTab === "pending" ? form.pendingContent : form.content} onChange={(event) => setForm((current) => ({ ...current, [editorTab === "pending" ? "pendingContent" : "content"]: event.target.value }))} placeholder={editorTab === "pending" ? `等待生成或填写${selectedDefinition.label}的候选内容…` : `填写${selectedDefinition.label}…`} /></label><div className="story-planning-actions">{editorTab === "pending" ? <><button type="button" className="primary-action" onClick={() => void confirmPending()} disabled={saving || !form.pendingContent.trim()}><Check size={15} />{saving ? "同步中…" : "确认采用"}</button><button type="button" className="secondary-action" onClick={() => void save()} disabled={saving || !form.pendingContent.trim()}><Save size={14} />保存待定内容</button></> : <button type="button" className="primary-action" onClick={() => void save()} disabled={saving || !form.content.trim()}><Save size={15} />{saving ? "保存中…" : "保存设定"}</button>}<button type="button" className="secondary-action" onClick={restoreContent} disabled={!previousForm}><RotateCcw size={14} />还原</button><button type="button" className="secondary-action destructive-action" onClick={clearContent} disabled={!(editorTab === "pending" ? form.pendingContent : form.content).trim()}><Trash2 size={14} />清除内容</button></div></div> : null}
          {notice ? <p className="project-notice story-planning-status">{notice}</p> : null}
          {error ? <p className="project-error story-planning-status" role="alert">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
