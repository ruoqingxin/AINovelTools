import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, BookOpenText, Check, CheckCircle2, Circle, Clock3, Plus, RotateCcw, Save, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { useJobs } from "../lib/jobs-query";
import { createPlanNode, enqueuePlanningAiJob, errorMessage, getCurrentProject, listModelProfiles, listPlanningSections, listPlanNodes, savePlanningSection, type Job, type PlanNode, type PlanningSection } from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { AiModelNote } from "./ai-model-note";
import { ChapterCreateDialog } from "./chapter-create-dialog";
import { buildPreparationStages, preparationProgress, preparationStatus, preparationStatusLabels, type PreparationItem } from "./creation-preparation";
import { usePlanningDraft } from "./use-planning-draft";
import "./creation-preparation.css";

function jobSection(job: Job) {
  if (job.jobType !== "AI_PLANNING_GENERATE") return null;
  try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId; } catch { return null; }
}

export function CreationPreparationView() {
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const stages = buildPreparationStages(nodes.data ?? []);
  const items = stages.flatMap((stage) => stage.items);
  const progress = preparationProgress(stages, sections.data ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? progress.missing[0] ?? items[0];
  useEffect(() => {
    if (selectedId === null && nodes.isSuccess && sections.isSuccess) setSelectedId(selected.id);
  }, [selectedId, nodes.isSuccess, sections.isSuccess, selected.id]);
  const stageIndex = stages.findIndex((stage) => stage.items.some((item) => item.id === selected.id));
  const stage = stages[stageIndex];
  const [pending, setPending] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const editorState = useRef<{ dirty: boolean; busy: boolean; form: PlanningSection | null }>({ dirty: false, busy: false, form: null });
  const changePending = useCallback((dirty: boolean, busy: boolean, form: PlanningSection | null) => {
    editorState.current = { dirty, busy, form };
    setPending(dirty || busy);
    setEditorBusy(busy);
  }, []);
  const selecting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [createChapterOpen, setCreateChapterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedChangesGuard(creating, "创作准备正在建立结构。");
  const previousMissing = stages.slice(0, stageIndex).flatMap((entry) => entry.items)
    .filter((item) => progress.missing.some((missing) => missing.id === item.id));
  const byId = new Map((sections.data ?? []).map((section) => [section.id, section]));

  async function select(id: string) {
    if (id === selected.id || creatingRef.current || editorState.current.busy || selecting.current) return;
    const expected = editorState.current.form;
    selecting.current = true;
    try {
      if (editorState.current.dirty && !await confirm({ message: "当前准备内容有未保存修改，放弃修改并切换吗？", confirmLabel: "放弃修改并切换" })) return;
      if (!mounted.current || creatingRef.current || editorState.current.busy) return;
      if (editorState.current.form !== expected) { setError("确认期间准备内容已变化，已保留当前输入。请重新确认。"); return; }
      setSelectedId(id);
      setError(null);
    } finally { selecting.current = false; }
  }

  async function createOutline() {
    if (creatingRef.current || previousMissing.length) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const node = await createPlanNode({ kind: "OUTLINE", title: "故事大纲" });
      client.setQueryData<PlanNode[]>(["plan-nodes"], (current) => [...(current ?? []).filter((item) => item.id !== node.id), node]);
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { creatingRef.current = false; setCreating(false); }
  }

  if (project.isPending || nodes.isPending || sections.isPending) return <p className="route-loading" role="status">正在读取创作准备…</p>;
  if (project.isError || nodes.isError || sections.isError) return <section className="preparation-workspace">
    <p role="alert" className="project-error">无法读取创作准备：{errorMessage(project.error ?? nodes.error ?? sections.error)}</p>
    <button type="button" className="secondary-action" onClick={() => void Promise.all([project.refetch(), nodes.refetch(), sections.refetch()])}>重试</button>
  </section>;

  function advance() {
    const index = items.findIndex((item) => item.id === selected.id);
    setSelectedId(items[index + 1]?.id ?? progress.missing.find((item) => item.id !== selected.id)?.id ?? selected.id);
  }

  return <section className="preparation-workspace">
    <header className="workspace-heading preparation-heading">
      <div><span className="preparation-project">{project.data?.name}</span><h1>创作准备</h1></div>
      <div className="preparation-progress"><span>关键准备 {progress.confirmed} / {progress.total}</span>
        <progress aria-label="关键准备确认进度" value={progress.confirmed} max={progress.total} /></div>
    </header>
    <nav className="preparation-stages" aria-label="创作准备阶段">
      {stages.map((entry, index) => {
        const required = entry.items.filter((item) => item.required);
        const done = required.filter((item) => item.sectionId && preparationStatus(byId.get(item.sectionId)) === "confirmed").length;
        return <button key={entry.id} type="button" aria-current={stage.id === entry.id ? "step" : undefined}
          disabled={creating || editorBusy} onClick={() => void select(entry.items.find((item) => item.required && progress.missing.some((missing) => missing.id === item.id))?.id ?? entry.items[0].id)}>
          <span className="preparation-stage-number">{done === required.length ? <Check size={16} /> : String(index + 1).padStart(2, "0")}</span>
          <span><strong>{entry.title}</strong><small>{done} / {required.length} 已确认</small></span>
        </button>;
      })}
    </nav>
    <div className="preparation-layout">
      <aside className="preparation-outline" aria-label="本阶段准备事项">
        <h2>{stage.title}</h2>
        {stage.items.map((item) => {
          const status = item.sectionId ? preparationStatus(byId.get(item.sectionId)) : "empty";
          return <button key={item.id} type="button" className="preparation-item" aria-current={item.id === selected.id ? "true" : undefined}
            disabled={creating || editorBusy} onClick={() => void select(item.id)}>
            {status === "confirmed" ? <CheckCircle2 size={16} /> : status === "deferred" ? <Clock3 size={16} /> : <Circle size={16} />}
            <span><strong>{item.title}{item.required ? "" : "（可选）"}</strong><small>{preparationStatusLabels[status]}</small></span>
          </button>;
        })}
        <div className="preparation-stage-links">
          {stageIndex > 0 ? <button type="button" disabled={creating || editorBusy} onClick={() => void select(stages[stageIndex - 1].items[0].id)}><ArrowLeft size={14} />上一阶段</button> : null}
          {stageIndex < stages.length - 1 ? <button type="button" disabled={creating || editorBusy} onClick={() => void select(stages[stageIndex + 1].items[0].id)}>下一阶段<ArrowRight size={14} /></button> : null}
        </div>
      </aside>
      <main className="preparation-editor" aria-label="准备内容">
        {selected.sectionId ? <PreparationEditor key={selected.id + selected.sectionId} item={selected} sections={sections.data ?? []}
          prerequisites={previousMissing} onContinue={advance}
          writingChapterId={progress.ready && !pending ? (nodes.data ?? []).find((node) => node.kind === "CHAPTER" && !node.archived)?.id : undefined}
          onPendingChange={changePending} /> : <div className="preparation-create">
          <h2>{selected.title}</h2><p>{selected.question}</p>
          {previousMissing.length ? <div className="preparation-prerequisites" role="status">
            <strong>前序关键准备尚有 {previousMissing.length} 项待确认</strong>
            {previousMissing.map((item) => <button key={item.id} type="button" onClick={() => void select(item.id)}>{item.title}<ArrowRight size={14} /></button>)}
          </div> : null}
          <button type="button" className="primary-action" disabled={creating || previousMissing.length > 0}
            onClick={() => selected.kind === "CHAPTER" ? setCreateChapterOpen(true) : void createOutline()}>
            <Plus size={15} />{creating ? "建立中…" : selected.kind === "CHAPTER" ? "建立开篇章节计划" : "建立主线大纲"}</button>
        </div>}
        {error ? <p role="alert" className="project-error">{error}</p> : null}
      </main>
      <aside className="preparation-basis" aria-label="已确认的创作依据">
        <h2>已确认的依据</h2>
        {items.filter((item) => item.id !== selected.id && item.sectionId && preparationStatus(byId.get(item.sectionId)) === "confirmed").map((item) =>
          <details key={item.id}><summary><CheckCircle2 size={14} />{item.title}</summary><p>{byId.get(item.sectionId!)?.content}</p></details>)}
        {items.every((item) => item.id === selected.id || !item.sectionId || preparationStatus(byId.get(item.sectionId)) !== "confirmed")
          ? <p className="preparation-muted">暂无其他已确认内容</p> : null}
        <div className="preparation-readiness"><strong>{progress.ready ? "开篇准备已确认" : `${progress.missing.length} 项关键准备待确认`}</strong>
        </div>
      </aside>
    </div>
    {createChapterOpen && project.data ? <ChapterCreateDialog projectId={project.data.projectId} nodes={nodes.data ?? []}
      onClose={() => setCreateChapterOpen(false)} onCreated={() => setSelectedId("opening")} /> : null}
  </section>;
}

function PreparationEditor({ item, sections, prerequisites, onContinue, onPendingChange, writingChapterId }: {
  item: PreparationItem; sections: PlanningSection[]; prerequisites: PreparationItem[];
  onContinue: () => void; onPendingChange: (dirty: boolean, busy: boolean, form: PlanningSection | null) => void;
  writingChapterId?: string;
}) {
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const stored = sections.find((section) => section.id === item.sectionId);
  const draft = usePlanningDraft(item.sectionId!, stored, true);
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const preferences = useAiTaskPreferences();
  const taskKey = item.kind === "OUTLINE" ? "outline" : item.kind === "CHAPTER" ? "chapterPlan" : "workDesign";
  const profile = resolveTaskChatProfile(profiles.data, preferences.data, taskKey);
  const preference = resolveTaskPreference(preferences.data, taskKey);
  const jobs = useJobs();
  const relatedJobs = (jobs.data ?? []).filter((job) => jobSection(job) === item.sectionId);
  const activeJob = relatedJobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const lastJob = relatedJobs[0];
  const [generating, setGenerating] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(() => !stored?.content.trim());
  const latest = useRef(draft.form);
  latest.current = draft.form;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = draft.baseline.storyState === "LOCKED";
  const busy = draft.saving || generating;
  const unresolved = Boolean(draft.form.pendingContent.trim()) || editing;
  const text = unresolved ? draft.form.pendingContent : draft.form.content;
  const alreadyConfirmed = !unresolved && preparationStatus(draft.form) === "confirmed";
  useUnsavedChangesGuard(draft.dirty || busy, "创作准备有未保存内容或正在处理的操作。");
  useEffect(() => { onPendingChange(draft.dirty, busy, draft.form); }, [draft.dirty, busy, draft.form, onPendingChange]);
  useEffect(() => () => onPendingChange(false, false, null), [onPendingChange]);
  useEffect(() => {
    if (lastJob?.status === "SUCCEEDED" || lastJob?.status === "FAILED") {
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    }
  }, [client, lastJob?.id, lastJob?.status]);

  async function save(decision: "draft" | "confirm" | "defer") {
    if (operation.current || locked || activeJob || decision === "confirm" && (prerequisites.length || !text.trim())) return;
    const snapshot = draft.beginSave();
    if (!snapshot) return;
    operation.current = true;
    setError(null);
    try {
      const proposed = unresolved ? snapshot.form.pendingContent : snapshot.form.content;
      const next = decision === "confirm"
        ? { ...snapshot.form, content: proposed.trim(), pendingContent: "", storyState: "CONFIRMED" as const, references: [] }
        : decision === "defer"
          ? { ...snapshot.form, storyState: "DEFERRED" as const }
          : snapshot.form;
      const saved = await savePlanningSection({ ...next, version: snapshot.baseline.version });
      draft.acknowledge(snapshot, saved);
      client.setQueryData<PlanningSection[]>(["planning-sections"], (current) => [...(current ?? []).filter((section) => section.id !== saved.id), saved]);
      setNotice(decision === "draft" ? "草稿已保存" : decision === "confirm" ? "作者已确认" : "已记录为暂不决定");
      if (decision === "confirm") setEditing(false);
      if (decision !== "draft") onContinue();
    } catch (cause) { setError(errorMessage(cause)); void client.invalidateQueries({ queryKey: ["planning-sections"] }); }
    finally { draft.finishSave(snapshot); operation.current = false; }
  }

  async function generate() {
    if (operation.current || !profile?.hasSecret || draft.dirty || activeJob || locked) return;
    operation.current = true;
    setGenerating(true);
    setError(null);
    try {
      const expected = draft.form;
      if (expected.pendingContent.trim() && !await confirm({ message: "重新推敲会替换当前已保存的讨论稿，继续吗？", confirmLabel: "重新推敲" })) return;
      if (!mounted.current) return;
      if (latest.current !== expected) { setError("确认期间准备内容已变化，未提交推敲任务。"); return; }
      await enqueuePlanningAiJob({
        profileId: profile.id, mode: "GENERATE", sectionId: item.sectionId!, sectionTitle: item.title,
        sectionPrompt: `${item.question}\n按以下方面组织可供作者讨论和修改的草稿：\n${item.placeholder}\n尊重已确认的创作依据，未决定的内容作为备选明确标注，不将推测写成作者已确认的事实。`,
        existingContext: sections.filter((section) => section.id !== item.sectionId && section.content.trim()
          && ["CONFIRMED", "LOCKED"].includes(section.storyState)).map((section) => `${section.id}: ${section.content}`).join("\n\n"),
        referenceContent: [draft.form.content, draft.form.pendingContent].filter(Boolean).join("\n\n"),
        userGuidance: ["先给出有因果依据的讨论稿，保留作者确认，不直接生成正文。",
          draft.form.pendingContent.trim() ? `作者当前草稿（尚未确认）：\n${draft.form.pendingContent}` : ""].filter(Boolean).join("\n\n"), allowRewrite: false,
        taskKey, temperature: preference.temperature ?? undefined, maxOutputTokens: preference.maxOutputTokens ?? undefined,
      });
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("讨论稿任务已提交");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { operation.current = false; setGenerating(false); }
  }

  async function revise() {
    if (locked || busy || operation.current) return;
    draft.setForm((current) => ({ ...current, pendingContent: current.content }));
    setEditing(true);
  }

  return <>
    <div className="preparation-editor-heading"><span>{item.required ? "关键准备" : "可选准备"}</span><h2>{item.title}</h2>
      <p>{item.question}</p></div>
    {prerequisites.length ? <p className="preparation-prerequisite-notice" role="status">前序关键准备尚有 {prerequisites.length} 项待确认</p> : null}
    <div className="preparation-editor-tools">
      <span className="preparation-state" data-state={preparationStatus(stored)}>{locked ? "作者已锁定" : preparationStatusLabels[preparationStatus(stored)]}</span>
      {!unresolved && !locked ? <button type="button" className="secondary-action" onClick={() => void revise()} disabled={busy}>修订草稿</button> : null}
      <button type="button" className="secondary-action" onClick={() => void generate()}
        disabled={busy || draft.dirty || Boolean(activeJob) || !profile?.hasSecret || locked}
        title={draft.dirty ? "先保存当前草稿" : undefined}><Sparkles size={14} />{generating ? "提交中…" : "AI 推敲讨论稿"}</button>
    </div>
    {profiles.isError || preferences.isError ? <p role="alert" className="project-error">无法读取 AI 配置
      <button type="button" onClick={() => void Promise.all([profiles.refetch(), preferences.refetch()])}>重试</button></p>
      : profiles.isSuccess && preferences.isSuccess && !profile?.hasSecret ? <a className="preparation-model-link" href="/settings#models">配置 AI 模型</a> : null}
    {activeJob ? <p role="status" className="preparation-job">讨论稿{activeJob.status === "QUEUED" ? "排队中" : "推敲中"} · {activeJob.progress}%</p> : null}
    {lastJob?.status === "FAILED" ? <p role="alert" className="project-error">讨论稿生成失败：{lastJob.errorSummary} <a href="/jobs">查看任务</a></p> : null}
    <label className="preparation-text-label">{unresolved ? "准备草稿" : alreadyConfirmed ? "已确认内容" : "准备内容"}
      <textarea rows={10} aria-label={item.title} value={text} placeholder={item.placeholder}
        readOnly={!unresolved || locked} disabled={!draft.ready || busy}
        onChange={(event) => { setEditing(true); draft.setForm((current) => ({ ...current, pendingContent: event.target.value })); }} />
    </label>
    {unresolved && draft.form.content.trim() ? <details className="preparation-original"><summary>上次确认内容</summary><p>{draft.form.content}</p></details> : null}
    <div className="preparation-savebar">
      <span role="status">{draft.saving ? "保存中…" : draft.dirty ? "有未保存修改" : notice ?? "无未保存修改"}</span>
      <div>
        {!item.required ? <button type="button" className="secondary-action" disabled={busy || locked || Boolean(activeJob)} onClick={() => void save("defer")}>
          <Clock3 size={14} />暂不决定</button> : null}
        <button type="button" className="secondary-action" onClick={() => void save("draft")} disabled={!draft.ready || busy || locked || !draft.dirty || Boolean(activeJob)}>
          <Save size={14} />保存草稿</button>
        {writingChapterId && !draft.dirty && !busy ? <Link to="/writing" hash={writingChapterId}
          className="primary-action"><BookOpenText size={15} />进入正文</Link> : <button type="button" className="primary-action" disabled={!draft.ready || busy || !text.trim() || prerequisites.length > 0 || Boolean(activeJob)}
          onClick={() => locked || alreadyConfirmed && !draft.dirty ? onContinue() : void save("confirm")}>
          <Check size={14} />{locked || alreadyConfirmed && !draft.dirty ? "继续下一项" : "确认并继续"}</button>}
      </div>
    </div>
    {draft.remoteChanged ? <div className="project-error" role="status">准备内容已有新版本，本地修改仍保留。
      <button type="button" disabled={busy} onClick={async () => {
        if (draft.dirty && !await confirm({ message: "放弃本地修改并读取最新准备内容吗？", confirmLabel: "读取最新内容" })) return;
        draft.reload();
      }}><RotateCcw size={14} />读取最新内容</button></div> : null}
    {error ? <p role="alert" className="project-error">{error}</p> : null}
    <details className="preparation-ai-details"><summary>AI 模型</summary>
      <AiModelNote compact taskLabel={item.title} taskKey={taskKey} profile={profile} preference={preference} /></details>
  </>;
}
