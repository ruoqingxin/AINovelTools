import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, BookOpenText, Check, CheckCircle2, Circle, Clock3, ListTree, Plus, RotateCcw, Save, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { useJobs } from "../lib/jobs-query";
import { createPlanNode, enqueuePlanningAiJob, errorMessage, getCurrentProject, listModelProfiles, listPlanningSections, listPlanNodes, savePlanningSection, type Job, type PlanNode, type PlanningSection } from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { AiModelNote } from "./ai-model-note";
import { ChapterCreateDialog } from "./chapter-create-dialog";
import { buildPreparationStages, preparationStatus, preparationStatusLabels, type PreparationItem } from "./creation-preparation";
import { planningDraftDirty, usePlanningDraft } from "./use-planning-draft";
import { assembleOutline, buildOutlineSteps, outlineHasSources, outlineSourcesChanged, withOutlineSources } from "./outline-steps";
import { openingReviewChecks, outlineReviewChecks, planningReviewChanges, planningReviewIsCurrent, readPlanningReview, withPlanningReview } from "./planning-review";
import { PlanningSectionDiscussion } from "./planning-section-discussion";
import "./creation-preparation.css";
import { aiWorkspaceHref, identityLabel, planningSectionIdentity } from "../lib/content-taxonomy";
import { AiWorkspaceLink, ContentTypeLabel, FormalContent, useInAiWorkspace } from "./content-identity";
import { WorkspaceLink } from "./workspace-link";
import { PreparationEntityReferences, usePreparationEntityReferences } from "./preparation-entity-references";

function jobSection(job: Job) {
  if (job.jobType !== "AI_PLANNING_GENERATE") return null;
  try { return (JSON.parse(job.payload) as { sectionId?: string }).sectionId; } catch { return null; }
}

export function CreationPreparationView({ embedded = false, initialItem }: { embedded?: boolean; initialItem?: string } = {}) {
  const aiWorkspace = useInAiWorkspace();
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const stages = buildPreparationStages(nodes.data ?? []);
  const items = stages.flatMap((stage) => stage.items);
  const [selectedId, setSelectedId] = useState<string | null>(items.some((item) => item.id === initialItem) ? initialItem! : null);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const workspace = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!workspace.current) return;
    workspace.current.scrollTop = 0;
    const layout = workspace.current.querySelector<HTMLElement>(".preparation-layout");
    if (layout) layout.scrollTop = 0;
    const content = workspace.current.closest<HTMLElement>(".ai-workspace-content");
    if (content) content.scrollTop = 0;
  }, [selected.id]);
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
  const changeUncreatedBusy = useCallback((busy: boolean) => changePending(false, busy, null), [changePending]);
  const selecting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [createChapterOpen, setCreateChapterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedChangesGuard(creating, "筹备正在建立结构。");
  const basisItems = stages.slice(0, stageIndex).flatMap((entry) => entry.items);
  const byId = new Map((sections.data ?? []).map((section) => [section.id, section]));
  const confirmedBasis = items.filter((item) => item.id !== selected.id && item.sectionId
    && preparationStatus(byId.get(item.sectionId), sections.data ?? []) === "confirmed");

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
    if (!aiWorkspace || creatingRef.current || editorState.current.busy) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const node = await createPlanNode({ kind: "OUTLINE", title: "主线大纲" });
      client.setQueryData<PlanNode[]>(["plan-nodes"], (current) => [...(current ?? []).filter((item) => item.id !== node.id), node]);
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { creatingRef.current = false; setCreating(false); }
  }

  if (project.isPending || nodes.isPending || sections.isPending) return <p className="route-loading" role="status">正在读取筹备…</p>;
  if (project.isError || nodes.isError || sections.isError) return <section className="preparation-workspace">
    <p role="alert" className="project-error">无法读取筹备：{errorMessage(project.error ?? nodes.error ?? sections.error)}</p>
    <button type="button" className="secondary-action" onClick={() => void Promise.all([project.refetch(), nodes.refetch(), sections.refetch()])}>重试</button>
  </section>;
  if (initialItem && !items.some((item) => item.id === initialItem)) return <p role="alert">准备事项不存在，未打开其他内容。</p>;

  function advance() {
    setSelectedId(!selected.primary ? stage.items[0].id : stages[stageIndex + 1]?.items[0].id ?? selected.id);
  }

  return <section className="preparation-workspace" ref={workspace}>
    <header className="workspace-heading preparation-heading">
      <div>{embedded ? <h2>故事准备</h2> : <h1>筹备</h1>}</div>
      {project.data && selected.kind !== "OUTLINE" ? <WorkspaceLink href={aiWorkspace
        ? aiWorkspaceHref({ projectId: project.data.projectId, workflow: "planning" }) : "/planning?mode=structure"}
        className="secondary-action">打开大纲规划<ArrowRight size={14} /></WorkspaceLink> : null}
    </header>
    <nav className="preparation-stages" aria-label="故事主题">
      {stages.map((entry) => {
        return <button key={entry.id} type="button" aria-current={stage.id === entry.id ? "page" : undefined}
          disabled={creating || editorBusy} onClick={() => void select(entry.items[0].id)}>
          <strong>{entry.title}</strong>
        </button>;
      })}
    </nav>
    <div className="preparation-layout">
      <aside className="preparation-outline" aria-label="主题内容">
        <h2>{stage.title}</h2>
        {stage.items.map((item) => {
          const status = item.sectionId ? preparationStatus(byId.get(item.sectionId), sections.data ?? []) : "empty";
          return <button key={item.id} type="button" className="preparation-item" aria-current={item.id === selected.id ? "true" : undefined}
            disabled={creating || editorBusy} onClick={() => void select(item.id)}>
            {status === "confirmed" ? <CheckCircle2 size={16} /> : status === "deferred" ? <Clock3 size={16} /> : <Circle size={16} />}
            <span><strong>{item.title}</strong><small>{item.primary ? preparationStatusLabels[status] : `${preparationStatusLabels[status]} · 可选`}</small></span>
          </button>;
        })}
        <div className="preparation-stage-links">
          {stageIndex > 0 ? <button type="button" disabled={creating || editorBusy} onClick={() => void select(stages[stageIndex - 1].items[0].id)}><ArrowLeft size={14} />上一主题</button> : null}
          {stageIndex < stages.length - 1 ? <button type="button" disabled={creating || editorBusy} onClick={() => void select(stages[stageIndex + 1].items[0].id)}>下一主题<ArrowRight size={14} /></button> : null}
        </div>
      </aside>
      <main className="preparation-editor" aria-label="准备内容">
        <div className="preparation-outcome"><strong>{stage.outcome}</strong>
          {project.data && selected.kind ? <WorkspaceLink href={aiWorkspace
            ? aiWorkspaceHref({ projectId: project.data.projectId, workflow: "planning", targetId: selected.sectionId?.slice("plan-node:".length) })
            : `/planning?mode=structure&targetProject=${encodeURIComponent(project.data.projectId)}${selected.sectionId ? `&planNode=${encodeURIComponent(selected.sectionId.slice("plan-node:".length))}` : ""}`}>
            {selected.kind === "CHAPTER" ? "章节计划" : "全书大纲"}<ArrowRight size={13} /></WorkspaceLink> : null}
        </div>
        {selected.id === "premise" ? <button type="button" className="preparation-genre" disabled={creating || editorBusy}
          onClick={() => void select("genre")}><span>题材</span>{byId.get("seed-genre")?.content.trim() || byId.get("seed-genre")?.pendingContent.trim() || "暂未确定"}<ArrowRight size={13} /></button> : null}
        {selected.sectionId ? <PreparationEditor key={selected.id + selected.sectionId} item={selected} sections={sections.data ?? []}
          prerequisites={[]} basisItems={basisItems} onContinue={selected.id === "opening" ? undefined : advance}
          writingChapterId={selected.id === "opening" && !pending ? (nodes.data ?? []).find((node) => node.kind === "CHAPTER" && !node.archived)?.id : undefined}
          onPendingChange={changePending} /> : <div className="preparation-create">
          <h2>{selected.title}</h2><p>{selected.question}</p>
          {aiWorkspace ? <><PlanningSectionDiscussion sectionId={`preparation:${selected.id}`} title={selected.title} question={selected.question}
            draftContent="" readOnly disabled={creating} onBusyChange={changeUncreatedBusy} onUseDraft={() => {}} />
          <button type="button" className="primary-action" disabled={creating || editorBusy}
            onClick={() => selected.kind === "CHAPTER" ? setCreateChapterOpen(true) : void createOutline()}>
            <Plus size={15} />{creating ? "建立中…" : selected.kind === "CHAPTER" ? "建立开篇章节计划" : "建立主线大纲"}</button></>
            : project.data ? <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "preparation", item: selected.id }}>去共创处理{selected.title}</AiWorkspaceLink> : null}
        </div>}
        {error ? <p role="alert" className="project-error">{error}</p> : null}
        {confirmedBasis.length > 0 ? <details className="preparation-basis">
          <summary>已确认依据</summary>
          {confirmedBasis.map((item) => <details key={item.id}>
            <summary><CheckCircle2 size={14} />{item.title}</summary><p>{byId.get(item.sectionId!)?.content}</p>
          </details>)}
        </details> : null}
      </main>
    </div>
    {createChapterOpen && project.data ? <ChapterCreateDialog projectId={project.data.projectId} nodes={nodes.data ?? []}
      onClose={() => setCreateChapterOpen(false)} onCreated={() => setSelectedId("opening")} /> : null}
  </section>;
}

type PreparationEditorProps = {
  item: PreparationItem; sections: PlanningSection[]; prerequisites: PreparationItem[]; basisItems?: PreparationItem[];
  onContinue?: () => void; onPendingChange: (dirty: boolean, busy: boolean, form: PlanningSection | null) => void;
  writingChapterId?: string;
};

export function PreparationEditor(props: PreparationEditorProps) {
  const workspace = useInAiWorkspace();
  return workspace ? <EditablePreparationEditor {...props} /> : <PreparationFormalContent {...props} />;
}

function PreparationFormalContent({ item, sections }: PreparationEditorProps) {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const section = sections.find((entry) => entry.id === item.sectionId);
  const entityReferences = usePreparationEntityReferences(item.entityTypes, section?.references ?? []);
  if (!project.data) return null;
  return <><FormalContent title={item.title} identity={planningSectionIdentity(item.sectionId ?? "")}
    content={section?.content ?? ""} status={preparationStatusLabels[preparationStatus(section, sections)]}
    pending={Boolean(section?.pendingContent.trim())}
    target={{ projectId: project.data.projectId, workflow: "preparation", item: item.id }} />
    {item.entityTypes && entityReferences.ids.length > 0 ? <PreparationEntityReferences model={entityReferences}
      references={section?.references ?? []} disabled readOnly /> : null}</>;
}

function EditablePreparationEditor(props: PreparationEditorProps) {
  return props.item.kind === "OUTLINE" ? <OutlinePreparationEditor {...props} /> : <SinglePreparationEditor {...props} />;
}

function OutlinePreparationEditor(props: PreparationEditorProps) {
  const { item, sections, prerequisites, basisItems = [], onPendingChange } = props;
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const steps = buildOutlineSteps(item.sectionId!);
  const main = sections.find((section) => section.id === item.sectionId);
  const jobs = useJobs();
  const generating = (jobs.data ?? []).some((job) => {
    const id = jobSection(job);
    return Boolean(id && (job.status === "QUEUED" || job.status === "RUNNING")
      && [item.sectionId, ...steps.map((step) => step.sectionId)].includes(id));
  });
  const missing = steps.filter((step) => preparationStatus(sections.find((section) => section.id === step.sectionId), sections) !== "confirmed");
  const hasMain = Boolean(main?.content.trim() || main?.pendingContent.trim());
  const [selected, setSelected] = useState(() => hasMain || !steps.some((step) => sections.some((section) => section.id === step.sectionId))
    ? "overview" : missing[0]?.id ?? "overview");
  const [assembling, setAssembling] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [childDirty, setChildDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useRef<{ dirty: boolean; busy: boolean; form: PlanningSection | null }>({ dirty: false, busy: false, form: null });
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const report = useCallback((dirty: boolean, busy: boolean, form: PlanningSection | null) => {
    state.current = { dirty, busy, form };
    setChildBusy(busy);
    setChildDirty(dirty);
    onPendingChange(dirty, busy, form);
  }, [onPendingChange]);
  useUnsavedChangesGuard(assembling, "大纲正在汇总。");
  const locked = main?.storyState === "LOCKED";
  const current = steps.find((step) => step.id === selected);
  const currentIndex = steps.findIndex((step) => step.id === selected);
  const previousStep = steps[currentIndex - 1];
  const previousSection = sections.find((section) => section.id === previousStep?.sectionId);
  const guided = steps.some((step) => sections.some((section) => section.id === step.sectionId));
  const latestInputs = useRef({ sections, generating });
  latestInputs.current = { sections, generating };
  const sourcesChanged = outlineSourcesChanged(main, sections);

  async function select(id: string) {
    if (id === selected || operation.current || state.current.busy) return;
    operation.current = true;
    const expected = state.current.form;
    try {
      if (state.current.dirty && !await confirm({ message: "当前情节有未保存修改，放弃修改并切换吗？", confirmLabel: "放弃修改并切换" })) return;
      if (!mounted.current) return;
      if (state.current.form !== expected) { setError("确认期间情节已变化，已保留当前输入。"); return; }
      setSelected(id);
      setError(null);
    } finally { operation.current = false; }
  }

  async function assemble() {
    if (operation.current || state.current.busy || state.current.dirty || missing.length || locked || generating) return;
    operation.current = true;
    const expected = state.current.form;
    try {
      if (main?.pendingContent.trim() && !await confirm({ message: "按已确认情节重新汇总会替换当前大纲草稿，正式大纲保留。继续吗？", confirmLabel: "重新汇总" })) return;
      if (!mounted.current) return;
      if (state.current.form !== expected) { setError("确认期间大纲草稿已变化，已保留当前输入。"); return; }
      if (latestInputs.current.sections !== sections || latestInputs.current.generating) { setError("情节已有更新，请核对后重新汇总。"); return; }
      setAssembling(true);
      onPendingChange(false, true, expected);
      setError(null);
      const saved = await savePlanningSection({
        ...(main ?? { id: item.sectionId!, content: "", storyState: "UNSET" as const, rationale: "", consequence: "", references: [], updatedAt: "", version: 0 }),
        pendingContent: assembleOutline(steps, sections),
        references: withOutlineSources(main?.references ?? [], steps, sections),
      });
      client.setQueryData<PlanningSection[]>(["planning-sections"], (entries) => [...(entries ?? []).filter((entry) => entry.id !== saved.id), saved]);
    } catch (cause) {
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    } finally {
      operation.current = false;
      if (mounted.current) { setAssembling(false); onPendingChange(state.current.dirty, state.current.busy, state.current.form); }
    }
  }

  return <>
    <ContentTypeLabel identity={planningSectionIdentity(item.sectionId ?? "")} />
    <nav className="outline-step-nav" aria-label="大纲情节">
      {steps.map((step, index) => {
        const done = !missing.some((entry) => entry.id === step.id);
        return <button type="button" key={step.id} aria-current={selected === step.id ? "step" : undefined}
          disabled={locked || assembling || childBusy} onClick={() => void select(step.id)}>
          {done ? <CheckCircle2 size={14} /> : <span aria-hidden="true">{index + 1}</span>}{step.title}</button>;
      })}
      <button type="button" aria-current={selected === "overview" ? "step" : undefined}
        disabled={assembling || childBusy} onClick={() => void select("overview")}>{guided ? "汇总审阅" : "主线草稿"}</button>
    </nav>
    {selected === "overview" && guided ? <div className="outline-assembly">
      <span>情节确认 {steps.length - missing.length} / {steps.length}</span>
      <button type="button" className="secondary-action" disabled={Boolean(missing.length) || locked || assembling || childBusy || childDirty || generating}
        onClick={() => void assemble()}><ListTree size={14} />{assembling ? "汇总中…" : "汇总为大纲草稿"}</button>
    </div> : null}
    {error ? <p role="alert" className="project-error">{error}</p> : null}
    {current && currentIndex > 0 ? <details className="outline-previous">
      <summary>前段情节 · {steps[currentIndex - 1].title}</summary>
      <p>{sections.find((section) => section.id === steps[currentIndex - 1].sectionId)?.content || "尚未确认"}</p>
    </details> : null}
    <SinglePreparationEditor key={current?.sectionId ?? item.sectionId} {...props}
      item={current ? { ...current, guidance: [current.guidance,
        previousSection && preparationStatus(previousSection, sections) === "confirmed"
          ? `前段已确认情节（${previousStep.title}）：\n${previousSection.content}` : ""].filter(Boolean).join("\n") } : item}
      prerequisites={current ? [...prerequisites, ...missing.filter((step) => steps.indexOf(step) < currentIndex)] : prerequisites}
      basisItems={current ? [...basisItems, ...steps.slice(0, currentIndex)] : [...basisItems, ...steps]}
      sections={sections} disabled={assembling} inheritedLock={Boolean(current && locked)}
      confirmationBlocked={!current && (generating || sourcesChanged) ? generating ? "大纲情节仍在推敲中" : "情节已修改，请重新汇总大纲。" : undefined}
      hideAi={!current && outlineHasSources(main)}
      onPendingChange={report} writingChapterId={current ? undefined : props.writingChapterId}
      onContinue={current ? () => setSelected(steps[currentIndex + 1]?.id ?? "overview") : props.onContinue}
      additionalContext={current ? main?.content || main?.pendingContent : undefined} />
  </>;
}

function SinglePreparationEditor({ item, sections, prerequisites, basisItems = [], onContinue, onPendingChange, writingChapterId, disabled = false, inheritedLock = false, additionalContext, confirmationBlocked, hideAi = false }: PreparationEditorProps & {
  disabled?: boolean; inheritedLock?: boolean; additionalContext?: string; confirmationBlocked?: string; hideAi?: boolean;
}) {
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const stored = sections.find((section) => section.id === item.sectionId);
  const draft = usePlanningDraft(item.sectionId!, stored, true);
  const entityReferences = usePreparationEntityReferences(item.entityTypes, draft.form.references);
  const latestEntityContext = useRef(entityReferences.context);
  latestEntityContext.current = entityReferences.context;
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const preferences = useAiTaskPreferences();
  const taskKey = item.kind === "OUTLINE" || item.kind === "OUTLINE_STEP" ? "outline" : item.kind === "CHAPTER" ? "chapterPlan" : "workDesign";
  const profile = resolveTaskChatProfile(profiles.data, preferences.data, taskKey);
  const preference = resolveTaskPreference(preferences.data, taskKey);
  const jobs = useJobs();
  const relatedJobs = (jobs.data ?? []).filter((job) => jobSection(job) === item.sectionId);
  const activeJob = relatedJobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const lastJob = relatedJobs[0];
  const [generating, setGenerating] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [discussionBusy, setDiscussionBusy] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(() => !stored?.content.trim());
  const latest = useRef(draft.form);
  latest.current = draft.form;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = inheritedLock || draft.baseline.storyState === "LOCKED";
  const busy = draft.saving || generating || unlocking || disabled || discussionBusy;
  const generationBlocked = useRef(false);
  generationBlocked.current = disabled || hideAi || locked || Boolean(activeJob) || !entityReferences.ready;
  const unresolved = Boolean(draft.form.pendingContent.trim()) || editing;
  const text = unresolved ? draft.form.pendingContent : draft.form.content;
  const alreadyConfirmed = !unresolved && preparationStatus(draft.form, sections) === "confirmed";
  const reviewChecks = item.kind === "OUTLINE" ? outlineReviewChecks : item.kind === "CHAPTER" ? openingReviewChecks : [];
  const basis = basisItems.flatMap((entry) => {
    const section = sections.find((section) => section.id === entry.sectionId);
    return section && preparationStatus(section, sections) === "confirmed" ? [section] : [];
  });
  const reviewKey = JSON.stringify([text, basis.map((section) => [section.id, section.version])]);
  const [review, setReview] = useState<{ key: string; checks: string[] }>({ key: "", checks: [] });
  const checked = review.key === reviewKey ? review.checks : [];
  const reviewComplete = reviewChecks.every((check) => checked.includes(check));
  const currentReviewCheck = reviewChecks.find((check) => !checked.includes(check));
  const changedBasis = planningReviewChanges(stored, sections);
  const reviewStale = !planningReviewIsCurrent(stored, sections);
  const existingReview = readPlanningReview(stored);
  useUnsavedChangesGuard(draft.dirty || busy, "筹备有未保存内容或正在处理的操作。");
  useEffect(() => { onPendingChange(draft.dirty, busy, draft.form); }, [draft.dirty, busy, draft.form, onPendingChange]);
  useEffect(() => () => onPendingChange(false, false, null), [onPendingChange]);
  useEffect(() => {
    if (lastJob?.status === "SUCCEEDED" || lastJob?.status === "FAILED") {
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    }
  }, [client, lastJob?.id, lastJob?.status]);

  async function save(decision: "draft" | "confirm" | "defer") {
    if (operation.current || disabled || locked || activeJob || decision === "confirm"
      && (confirmationBlocked || prerequisites.length || !text.trim() || !reviewComplete || !entityReferences.ready)) return;
    const snapshot = draft.beginSave();
    if (!snapshot) return;
    operation.current = true;
    setError(null);
    try {
      const proposed = unresolved ? snapshot.form.pendingContent : snapshot.form.content;
      const next = decision === "confirm"
        ? { ...snapshot.form, content: proposed.trim(), pendingContent: "", storyState: "CONFIRMED" as const,
          references: reviewChecks.length || item.kind === "OUTLINE_STEP"
            ? withPlanningReview({ ...snapshot.form, version: snapshot.baseline.version }, checked, basis) : snapshot.form.references }
        : decision === "defer"
          ? { ...snapshot.form, storyState: "DEFERRED" as const }
          : snapshot.form;
      const saved = await savePlanningSection({ ...next, version: snapshot.baseline.version });
      draft.acknowledge(snapshot, saved);
      client.setQueryData<PlanningSection[]>(["planning-sections"], (current) => [...(current ?? []).filter((section) => section.id !== saved.id), saved]);
      setNotice(decision === "draft" ? "草稿已保存" : decision === "confirm" ? "作者已确认" : "已记录为暂不决定");
      if (decision === "confirm") setEditing(false);
      if (decision !== "draft") onContinue?.();
    } catch (cause) {
      draft.retainFailedSave(snapshot);
      setError(errorMessage(cause));
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    }
    finally { draft.finishSave(snapshot); operation.current = false; }
  }

  async function generate() {
    if (operation.current || !draft.ready || disabled || hideAi || !profile?.hasSecret || activeJob || locked || !entityReferences.ready) return;
    operation.current = true;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const expected = draft.form;
      if (draft.baseline.pendingContent.trim() && !await confirm({ message: "重新推敲会替换当前已保存的讨论稿，继续吗？", confirmLabel: "重新推敲" })) return;
      if (!mounted.current) return;
      if (latest.current !== expected) { setError("确认期间准备内容已变化，未提交推敲任务。"); return; }
      let source = expected;
      if (draft.dirty) {
        const snapshot = draft.beginSave();
        if (!snapshot) return;
        try {
          source = await savePlanningSection({ ...snapshot.form, version: snapshot.baseline.version });
          draft.acknowledge(snapshot, source);
          client.setQueryData<PlanningSection[]>(["planning-sections"], (current) => [...(current ?? []).filter((section) => section.id !== source.id), source]);
          setNotice("草稿已保存");
        } catch (cause) {
          draft.retainFailedSave(snapshot);
          void client.invalidateQueries({ queryKey: ["planning-sections"] });
          throw cause;
        } finally { draft.finishSave(snapshot); }
        if (!mounted.current) return;
        if (planningDraftDirty(latest.current, expected)) {
          setError("保存期间内容已变化，已保留最新输入，未提交推敲任务。");
          return;
        }
      }
      if (generationBlocked.current || latestEntityContext.current !== entityReferences.context) {
        setError("当前内容状态已变化，未提交推敲任务。"); return;
      }
      await enqueuePlanningAiJob({
        profileId: profile.id, mode: "GENERATE", sectionId: item.sectionId!, sectionTitle: item.title,
        sectionPrompt: `内容分类：${identityLabel(planningSectionIdentity(item.sectionId ?? ""))}。未归类笔记不代表正式设定事实。\n${item.question}\n本次只处理“${item.title}”这一项，给出一份${item.kind === "OUTLINE_STEP" ? "具体、连贯的情节稿，交代行动缘由、人物选择与局面变化" : "简短、连贯的讨论稿"}。不扩展其他准备事项，不列填空清单，不提供多套方案。\n${item.guidance ?? item.placeholder}\n尊重已确认的创作依据，未知之处保留待定，不将推测写成作者已确认的事实。`,
        existingContext: sections.filter((section) => section.id !== item.sectionId
          && preparationStatus(section, sections) === "confirmed").map((section) => `[${identityLabel(planningSectionIdentity(section.id))}] ${section.id}: ${section.content}`).join("\n\n"),
        referenceContent: [entityReferences.context, additionalContext ? `原主线大纲（细化参考）：\n${additionalContext}` : "", source.content, source.pendingContent].filter(Boolean).join("\n\n"),
        userGuidance: [item.kind === "OUTLINE_STEP" ? "只展开当前这一段的具体情节，不生成整份大纲，不直接写正文。输出供作者确认的情节稿，不代替作者定稿。" : "一次只推敲当前这一项，输出一份短稿，保留作者确认，不直接生成正文。",
          additionalContext ? `原大纲参考（不代表本段已确认内容）：\n${additionalContext}` : "",
          source.pendingContent.trim() ? `作者当前草稿（尚未确认）：\n${source.pendingContent}` : ""].filter(Boolean).join("\n\n"), allowRewrite: false,
        taskKey, temperature: preference.temperature ?? undefined, maxOutputTokens: preference.maxOutputTokens ?? undefined,
      });
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("讨论稿任务已提交");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { operation.current = false; setGenerating(false); }
  }

  async function revise() {
    if (locked || busy || operation.current || activeJob) return;
    draft.setForm((current) => ({ ...current, pendingContent: current.content }));
    setEditing(true);
  }

  async function unlock() {
    if (!locked || busy || operation.current || activeJob) return;
    operation.current = true;
    setUnlocking(true);
    setError(null);
    try {
      const expected = draft.form;
      if (!await confirm({ message: "解除作者锁定后可以另建修订草稿，原正式内容保留。继续吗？", confirmLabel: "解除锁定" })) return;
      if (!mounted.current || latest.current !== expected) return;
      const snapshot = draft.beginSave();
      if (!snapshot) return;
      try {
        const saved = await savePlanningSection({ ...snapshot.form, version: snapshot.baseline.version, storyState: "CONFIRMED" });
        draft.acknowledge(snapshot, saved);
        client.setQueryData<PlanningSection[]>(["planning-sections"], (current) => [...(current ?? []).filter((section) => section.id !== saved.id), saved]);
        setNotice("作者锁定已解除");
      } catch (cause) { draft.retainFailedSave(snapshot); setError(errorMessage(cause)); }
      finally { draft.finishSave(snapshot); }
    } finally { operation.current = false; setUnlocking(false); }
  }

  return <>
    <div className="preparation-editor-heading"><h2>{item.title}</h2>
      <p>{item.question}</p></div>
    <ContentTypeLabel identity={planningSectionIdentity(item.sectionId ?? "")} />
    {item.entityTypes ? <PreparationEntityReferences model={entityReferences} references={draft.form.references}
      disabled={!draft.ready || busy || locked || Boolean(activeJob)} readOnly={!unresolved}
      onChange={(references) => draft.setForm((current) => ({ ...current, references }))} /> : null}
    <PlanningSectionDiscussion sectionId={item.id === "outline" || item.id === "opening" ? `preparation:${item.id}` : item.sectionId!}
      title={item.title} question={[item.question, item.guidance].filter(Boolean).join("\n")}
      referenceContent={entityReferences.context}
      draftContent={draft.form.pendingContent} disabled={!draft.ready || disabled || draft.saving || generating || unlocking || Boolean(activeJob) || !entityReferences.ready}
      readOnly={locked} onBusyChange={setDiscussionBusy} onUseDraft={(content) => {
        setEditing(true);
        draft.setForm((current) => ({ ...current, pendingContent: content }));
        setNotice(null);
      }} />
    {prerequisites.length ? <div className="preparation-prerequisite-notice" role="status">
      前序关键准备尚有 {prerequisites.length} 项待确认
      <ul>{prerequisites.map((entry) => <li key={entry.id}>{entry.title}</li>)}</ul>
    </div> : null}
    {reviewStale ? <p className="preparation-review-warning" role="status">确认依据已有变化，当前正式版本保留，待作者复核。
      {changedBasis.length ? ` 变化项：${changedBasis.map((id) => basisItems.find((entry) => entry.sectionId === id)?.title ?? id).join("、")}` : null}</p> : null}
    {confirmationBlocked ? <p className="preparation-review-warning" role="status">{confirmationBlocked}</p> : null}
    <div className="preparation-editor-tools">
      <span className="preparation-state" data-state={preparationStatus(stored, sections)}>{locked ? "作者已锁定" : reviewStale ? "待复核" : preparationStatusLabels[preparationStatus(stored, sections)]}
        {stored?.content.trim() ? ` · 正式版本 ${stored.version ?? 0}` : ""}</span>
      {!unresolved && !locked ? <button type="button" className="secondary-action" onClick={() => void revise()} disabled={busy || Boolean(activeJob)}>修订草稿</button> : null}
      {locked && !disabled && !inheritedLock ? <button type="button" className="secondary-action" onClick={() => void unlock()} disabled={busy || Boolean(activeJob)}>{unlocking ? "解锁中…" : "解除锁定"}</button> : null}
      {!hideAi ? <button type="button" className="secondary-action" onClick={() => void generate()}
        disabled={!draft.ready || busy || Boolean(activeJob) || !profile?.hasSecret || locked || !entityReferences.ready}>
        <Sparkles size={14} />{generating ? draft.saving ? "保存中…" : "提交中…" : draft.dirty && !locked ? "保存并推敲" : "AI 推敲讨论稿"}</button> : null}
      {!hideAi && profiles.isSuccess && preferences.isSuccess && !profile?.hasSecret ? <a className="preparation-model-link" href="/settings#models">配置 AI 模型</a> : null}
    </div>
    {profiles.isError || preferences.isError ? <p role="alert" className="project-error">无法读取 AI 配置
      <button type="button" onClick={() => void Promise.all([profiles.refetch(), preferences.refetch()])}>重试</button></p>
      : null}
    {activeJob ? <p role="status" className="preparation-job">讨论稿{activeJob.status === "QUEUED" ? "排队中" : "推敲中"} · {activeJob.progress}%</p> : null}
    {lastJob?.status === "FAILED" ? <p role="alert" className="project-error">讨论稿生成失败：{lastJob.errorSummary} <a href="/jobs">查看任务</a></p> : null}
    <label className="preparation-text-label" data-compact={!item.kind || item.kind === "OUTLINE_STEP"}>{unresolved ? "准备草稿" : alreadyConfirmed ? "已确认内容" : "准备内容"}
      {item.id === "genre" ? <input aria-label={item.title} value={text} placeholder={item.placeholder}
        readOnly={!unresolved || locked} disabled={!draft.ready || busy}
        onChange={(event) => { setEditing(true); draft.setForm((current) => ({ ...current, pendingContent: event.target.value })); }} />
        : <textarea rows={item.kind === "OUTLINE" ? 8 : item.kind === "CHAPTER" ? 6 : 4} aria-label={item.title} value={text} placeholder={item.placeholder}
        readOnly={!unresolved || locked} disabled={!draft.ready || busy}
        onChange={(event) => { setEditing(true); draft.setForm((current) => ({ ...current, pendingContent: event.target.value })); }} />}
    </label>
    {unresolved && draft.form.content.trim() ? <details className="preparation-original"><summary>上次确认内容</summary><p>{draft.form.content}</p></details> : null}
    {reviewChecks.length ? <section className="preparation-review" aria-label="作者审阅">
      <div className="preparation-review-heading"><h3>作者审阅</h3><span>{alreadyConfirmed
        ? existingReview ? `${existingReview.checks.length} 项已审阅` : "历史确认，尚无逐项审阅记录"
        : `${checked.length} / ${reviewChecks.length}`}</span></div>
      {alreadyConfirmed || locked ? <ul>{(existingReview?.checks ?? reviewChecks).map((check) => <li key={check}>{existingReview ? <CheckCircle2 size={14} /> : <Circle size={14} />}{check}</li>)}</ul>
        : currentReviewCheck ? <label><input type="checkbox" checked={false}
          disabled={busy || Boolean(activeJob) || !text.trim()} onChange={() => setReview({ key: reviewKey,
            checks: [...checked, currentReviewCheck] })} />{currentReviewCheck}</label>
          : <p className="preparation-review-complete"><CheckCircle2 size={14} />本轮审阅完成</p>}
      {!alreadyConfirmed && !locked && checked.length > 0 ? <button type="button" className="preparation-review-back"
        disabled={busy || Boolean(activeJob)} onClick={() => setReview({ key: reviewKey, checks: checked.slice(0, -1) })}>
        <ArrowLeft size={13} />上一条</button> : null}
      <details className="preparation-decision-details"><summary>待定问题与取舍{draft.form.consequence.trim() ? " · 已记录" : ""}</summary>
        <label className="preparation-decision-note">备注
        <textarea aria-label="待定问题与取舍" rows={2} value={draft.form.consequence} readOnly={locked || alreadyConfirmed}
          disabled={busy || Boolean(activeJob)} placeholder="记下暂未确定的部分。"
          onChange={(event) => draft.setForm((current) => ({ ...current, consequence: event.target.value }))} /></label></details>
    </section> : null}
    <div className="preparation-savebar">
      <span role="status">{draft.saving ? "保存中…" : draft.dirty ? "有未保存修改" : notice ?? "无未保存修改"}</span>
      <div>
        {item.kind !== "OUTLINE_STEP" ? <button type="button" className="secondary-action" disabled={busy || locked || Boolean(activeJob)} onClick={() => void save("defer")}>
          <Clock3 size={14} />暂不决定</button> : null}
        <button type="button" className="secondary-action" onClick={() => void save("draft")} disabled={!draft.ready || busy || locked || !draft.dirty || Boolean(activeJob)}>
          <Save size={14} />保存草稿</button>
        {writingChapterId && !draft.dirty && !busy ? <Link to="/writing" hash={writingChapterId}
          className="secondary-action"><BookOpenText size={15} />进入正文</Link> : null}
        <button type="button" className="primary-action"
          disabled={!draft.ready || busy || inheritedLock || !text.trim() || prerequisites.length > 0 || Boolean(activeJob) || Boolean(confirmationBlocked) || !entityReferences.ready
            || (!alreadyConfirmed && !locked && !reviewComplete) || (!onContinue && (locked || alreadyConfirmed) && !draft.dirty)}
          onClick={() => locked || alreadyConfirmed && !draft.dirty ? onContinue?.() : void save("confirm")}>
          <Check size={14} />{locked || alreadyConfirmed && !draft.dirty ? onContinue ? "继续下一项" : "已确认"
            : onContinue ? "确认并继续" : item.kind === "CHAPTER" ? "确认章节计划" : item.kind === "OUTLINE" || item.kind === "OUTLINE_STEP" ? "确认为正式大纲" : "确认当前准备内容"}</button>
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
