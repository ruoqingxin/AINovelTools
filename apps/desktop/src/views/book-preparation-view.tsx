import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Pencil, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { aiWorkspaceHref } from "../lib/content-taxonomy";
import { useJobs } from "../lib/jobs-query";
import { errorMessage, getCurrentProject, listPlanningSections, savePlanningSection, type PlanningSection } from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { basicBookPreparationKeys, bookPreparationFields, changedBookDirections, legacyStoryDirectionItems, readBookPreparation, withBookPreparation, type BookPreparation } from "./book-preparation";
import { useInAiWorkspace } from "./content-identity";
import { usePlanningDraft } from "./use-planning-draft";
import { PlanningSectionDiscussion } from "./planning-section-discussion";
import { PlanningDiscussionSources } from "./planning-discussion-sources";
import "./book-preparation.css";
import { WorkspaceLink } from "./workspace-link";

const perspectives = ["第一人称 · 固定主角", "第一人称 · 多人物切换", "第三人称 · 限定视角", "第三人称 · 全知视角", "第三人称 · 多人物切换", "第二人称"];
const boundaryChoices = ["不写后宫", "不靠误会拖剧情", "不写过度血腥", "不让主角无故违背立场"];

export function BookPreparationView({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const editable = useInAiWorkspace();
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const jobs = useJobs();
  const latestJob = jobs.data?.find((job) => {
    if (!["AI_PLANNING_GENERATE", "AI_PLANNING_EXTRACT"].includes(job.jobType)) return false;
    try { return JSON.parse(job.payload).sectionId === "seed-tone"; } catch { return false; }
  });
  useEffect(() => {
    if (latestJob?.status === "SUCCEEDED" || latestJob?.status === "FAILED") {
      void client.invalidateQueries({ queryKey: ["planning-sections"] });
    }
  }, [client, latestJob?.id, latestJob?.status]);
  const stored = sections.data?.find((section) => section.id === "seed-tone");
  const draft = usePlanningDraft("seed-tone", stored, sections.isSuccess);
  const fields = readBookPreparation(editable ? draft.form : stored);
  const completed = basicBookPreparationKeys.filter((key) => fields[key].trim()).length;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [discussionBusy, setDiscussionBusy] = useState(false);
  const [customFields, setCustomFields] = useState<Set<keyof BookPreparation>>(() => new Set());
  const operation = useRef(false);
  const latest = useRef(draft.form);
  latest.current = draft.form;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = draft.saving || confirming || discussionBusy;
  useUnsavedChangesGuard(editable && (draft.dirty || busy), "本书偏好有未保存修改。");
  useEffect(() => {
    onDirtyChange?.(editable && (draft.dirty || busy));
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, editable, draft.dirty, busy]);

  function change(key: keyof BookPreparation, value: string) {
    draft.setForm((current) => withBookPreparation(current, { ...readBookPreparation(current), [key]: value }));
    setNotice(null);
  }

  async function save(adopt = false) {
    if (!editable || operation.current || !draft.ready || busy) return;
    const expected = draft.form;
    const proposed = adopt ? { ...expected, content: expected.pendingContent, pendingContent: "",
      references: expected.references.filter((entry) => !entry.startsWith("book-preparation:v1:")) } : expected;
    const changed = changedBookDirections(draft.baseline, proposed);
    operation.current = true;
    setConfirming(true);
    setError(null);
    try {
      if ((changed.length || adopt && expected.content.trim()) && !await confirm({
        message: adopt ? "用候选替换当前本书偏好？已有正文和大纲保留，不会自动重写，请留意与新偏好的一致性。"
          : `${changed.join("、")}将发生变化。已有正文和大纲保留，不会自动重写，请留意与新偏好的一致性。`,
        confirmLabel: adopt ? "采用为本书偏好" : "保存新偏好",
      })) return;
      if (!mounted.current) return;
      if (latest.current !== expected) { setError("确认期间偏好已变化，已保留当前输入，请重新确认。"); return; }
      const snapshot = draft.beginSave();
      if (!snapshot) return;
      try {
        const saved = await savePlanningSection({
          ...proposed, version: snapshot.baseline.version,
          storyState: ["UNSET", "AI_SUGGESTED"].includes(proposed.storyState)
            ? proposed.content.trim() ? "CONFIRMED" : proposed.pendingContent.trim() ? "AI_SUGGESTED" : "UNSET"
            : proposed.storyState,
        });
        draft.acknowledge(snapshot, saved);
        client.setQueryData<PlanningSection[]>(["planning-sections"], (items) => [...(items ?? []).filter((item) => item.id !== saved.id), saved]);
        setNotice("偏好已保存");
      } catch (cause) {
        draft.retainFailedSave(snapshot);
        setError(errorMessage(cause));
        void client.invalidateQueries({ queryKey: ["planning-sections"] });
      } finally { draft.finishSave(snapshot); }
    } finally { operation.current = false; if (mounted.current) setConfirming(false); }
  }

  async function reload() {
    if (operation.current || busy) return;
    const expected = draft.form;
    operation.current = true;
    setConfirming(true);
    try {
      if (!await confirm({ message: "放弃本地修改并读取最新偏好吗？", confirmLabel: "读取最新内容" })) return;
      if (!mounted.current) return;
      if (latest.current !== expected) { setError("确认期间偏好已变化，已保留当前输入，请重新确认。"); return; }
      draft.reload();
      setCustomFields(new Set());
      setError(null);
      setNotice(null);
    } finally { operation.current = false; if (mounted.current) setConfirming(false); }
  }

  if (sections.isPending || project.isPending) return <p role="status">正在读取本书偏好…</p>;
  if (sections.isError || project.isError) return <div role="alert" className="project-error">
    无法读取本书偏好：{errorMessage(sections.error ?? project.error)}
    <button type="button" onClick={() => void Promise.all([sections.refetch(), project.refetch()])}>重试</button>
  </div>;
  if (!project.data) return null;

  function field(key: keyof BookPreparation, options: { placeholder?: string; multiline?: boolean; choices?: string[]; choiceLabels?: Record<string, string>; wide?: boolean } = {}) {
    const label = bookPreparationFields[key];
    const custom = Boolean(options.choices && (customFields.has(key) || fields[key] && !options.choices.includes(fields[key])));
    return <label className={`book-brief-field${options.wide ? " book-brief-wide" : ""}`} key={key}>
      <span>{label}{key === "targetWords" ? <small>万字</small> : null}</span>
      {!editable ? <div className="book-brief-value">{fields[key] || "暂未确定"}</div>
        : options.choices ? <><select aria-label={label} value={custom ? "__custom__" : fields[key]} disabled={!draft.ready || busy}
          onChange={(event) => {
            const value = event.target.value;
            setCustomFields((current) => {
              const next = new Set(current);
              if (value === "__custom__") next.add(key); else next.delete(key);
              return next;
            });
            change(key, value === "__custom__" ? "" : value);
          }}>
          <option value="">暂未确定</option>
          {options.choices.map((choice) => <option key={choice} value={choice}>{options.choiceLabels?.[choice] ?? choice}</option>)}
          <option value="__custom__">自定义</option>
        </select>{custom ? <input aria-label={`${label}（自定义）`} type={key === "targetWords" ? "number" : "text"}
          min={key === "targetWords" ? "0.01" : undefined} step={key === "targetWords" ? "any" : undefined}
          value={fields[key]} disabled={!draft.ready || busy} placeholder={options.placeholder ?? "自定义"}
          onChange={(event) => change(key, event.target.value)} /> : null}</>
          : options.multiline ? <textarea aria-label={label} rows={key === "premise" ? 3 : 4} value={fields[key]}
            disabled={!draft.ready || busy} placeholder={options.placeholder ?? "暂未确定"}
            onChange={(event) => change(key, event.target.value)} />
            : <input aria-label={label} type={key === "targetWords" ? "number" : "text"} min={key === "targetWords" ? "0.01" : undefined}
              step={key === "targetWords" ? "any" : undefined} value={fields[key]} disabled={!draft.ready || busy}
              placeholder={options.placeholder ?? "暂未确定"} onChange={(event) => change(key, event.target.value)} />}
    </label>;
  }

  const projectId = project.data.projectId;
  const storyHref = (item: string) => editable
    ? aiWorkspaceHref({ projectId, workflow: "preparation", item })
    : `/planning?mode=prepare&item=${encodeURIComponent(item)}`;
  const legacyDirections = legacyStoryDirectionItems.filter(({ key }) => fields[key].trim());
  return <section className="book-preparation" aria-label="本书偏好">
    <header className="book-brief-heading"><div><span>{project.data.name}</span><h2>本书偏好</h2></div>
      {editable ? <span className="book-brief-progress">已记录 {completed} / {basicBookPreparationKeys.length}</span>
        : <WorkspaceLink className="primary-action" href={aiWorkspaceHref({ projectId: project.data.projectId, workflow: "preparation" })}><Pencil size={14} />编辑偏好</WorkspaceLink>}</header>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="book-brief-fields">
        {field("targetWords", { choices: ["3", "10", "20", "50", "100", "200"], choiceLabels: {
          "3": "3 万字", "10": "10 万字", "20": "20 万字", "50": "50 万字", "100": "100 万字", "200": "200 万字",
        } })}
        {field("perspective", { choices: perspectives })}
        {field("style", { choices: ["简洁直白", "细腻写实", "轻松幽默", "古典雅致", "诗意抒情", "冷峻克制"],
          placeholder: "例如：简洁直白，带一点冷幽默" })}
        {field("tone", { choices: ["轻松", "热血", "温暖", "悬疑", "压抑", "悲凉"], placeholder: "例如：温暖底色，穿插悬疑" })}
      </div>
      <details className="book-brief-supplement">
        <summary>节奏、读者与边界<span>{(["pace", "audience", "boundaries"] as const).filter((key) => fields[key].trim()).length} / 3</span></summary>
        <div className="book-brief-fields">
          {field("pace", { choices: ["偏快 · 重情节推进", "适中 · 情节与人物并重", "慢热 · 重人物与心理"] })}
          {field("audience", { choices: ["大众读者", "青少年读者", "成年读者", "类型小说读者", "网络连载读者"],
            placeholder: "例如：偏爱现实推理的成年读者" })}
          <fieldset className="book-brief-boundaries book-brief-wide"><legend>创作边界</legend>
            {editable ? <><div className="book-brief-checkboxes">
              {boundaryChoices.map((choice) =>
                <label key={choice}><input type="checkbox" checked={fields.boundaries.split("\n").includes(choice)} disabled={!draft.ready || busy}
                  onChange={(event) => {
                    const entries = fields.boundaries.split("\n").filter(Boolean).filter((entry) => entry !== choice);
                    change("boundaries", [...entries, ...(event.target.checked ? [choice] : [])].join("\n"));
                  }} />{choice}</label>)}
            </div><label className="book-brief-field"><span>其他边界</span><textarea aria-label="其他边界" rows={2}
              value={fields.boundaries.split("\n").filter((entry) => !boundaryChoices.includes(entry)).join("\n")}
              disabled={!draft.ready || busy} placeholder="暂未确定" onChange={(event) => {
                const selected = fields.boundaries.split("\n").filter((entry) => boundaryChoices.includes(entry));
                change("boundaries", [...selected, event.target.value].filter(Boolean).join("\n"));
              }} /></label></> : <div className="book-brief-value">{fields.boundaries || "暂未确定"}</div>}
          </fieldset>
        </div>
      </details>
      <details className="book-brief-supplement" open={Boolean(fields.notes.trim()) || undefined}>
        <summary>偏好备注{fields.notes.trim() ? <span>已有内容</span> : null}</summary>
        <div className="book-brief-fields">{field("notes", { multiline: true, wide: true, placeholder: "其他已决定的偏好，也可以留空。" })}</div>
      </details>
      {legacyDirections.length > 0 && <details className="book-brief-supplement">
        <summary>历史故事方向<span>{legacyDirections.length} 项</span></summary>
        <dl className="book-brief-legacy">{legacyDirections.map(({ key, item, title }) => <div key={key}>
          <dt>{title}<WorkspaceLink href={storyHref(item)} aria-label={`前往故事准备：${title}`}>前往故事准备<ArrowRight size={13} /></WorkspaceLink></dt>
          <dd>{fields[key]}</dd>
        </div>)}</dl>
      </details>}
      {editable ? <details className="book-brief-supplement"><summary>笔记选项</summary>
        <label className="book-brief-field"><span>笔记状态</span><select aria-label="笔记状态" value={draft.form.storyState}
          disabled={!draft.ready || busy} onChange={(event) => draft.setForm((current) => ({ ...current, storyState: event.target.value as PlanningSection["storyState"] }))}>
          {Object.entries({ UNSET: "尚未记录", UNKNOWN: "明确未知", DEFERRED: "暂不决定", AUTHOR_RESERVED: "作者保留",
            AI_SUGGESTED: "AI 建议", CONFIRMED: "作者已确认", LOCKED: "作者已锁定", RETIRED: "已废弃或替代" }).map(([value, label]) =>
            <option key={value} value={value} disabled={["CONFIRMED", "LOCKED"].includes(value) && !draft.form.content.trim()
              || value === "AI_SUGGESTED" && !draft.form.pendingContent.trim()}>{label}</option>)}
        </select></label>
      </details> : null}
      {editable ? <footer className="book-brief-savebar">
        <span role="status">{draft.saving ? "保存中…" : draft.dirty ? "有未保存修改" : notice ?? "无未保存修改"}</span>
        <button type="submit" className="primary-action" disabled={!draft.ready || busy || !draft.dirty}><Save size={15} />保存偏好</button>
      </footer> : null}
    </form>
    {editable && draft.form.pendingContent.trim() ? <details className="book-brief-supplement" open>
      <summary>偏好候选</summary>
      <label className="book-brief-field"><span>候选</span><textarea aria-label="笔记候选" rows={5} value={draft.form.pendingContent}
        disabled={busy} onChange={(event) => draft.setForm((current) => ({ ...current, pendingContent: event.target.value }))} /></label>
      <div className="book-brief-candidate-actions">
        <button type="button" className="secondary-action" disabled={!draft.ready || busy || !draft.form.pendingContent.trim()} onClick={() => void save(true)}>
          <Check size={14} />采用为本书偏好</button>
      </div>
    </details> : null}
    {editable ? <details className="book-brief-supplement"><summary>讨论本书偏好</summary>
      <PlanningSectionDiscussion sectionId="seed-tone" title="本书偏好"
        question="这本书预计多少字，采用什么叙事视角、语言风格、基调、节奏和创作边界？只讨论作者偏好，不补定题材、剧情、阅读期待或结局。"
        draftContent={draft.form.pendingContent}
        referenceContent={[draft.form.content, draft.form.pendingContent].filter(Boolean).join("\n\n")}
        disabled={!draft.ready || draft.saving || confirming} readOnly={draft.form.storyState === "LOCKED"} onBusyChange={setDiscussionBusy}
        onUseDraft={(content) => { draft.setForm((current) => ({ ...current, pendingContent: content })); setNotice(null); }} />
      <PlanningDiscussionSources sectionId="seed-tone" />
    </details> : null}
    <div className="book-brief-next">
      {stored?.pendingContent.trim() && !editable ? <span>有偏好候选待确认</span> : null}
      <WorkspaceLink href={storyHref("premise")}>继续故事准备<ArrowRight size={14} /></WorkspaceLink>
    </div>
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {editable && draft.remoteChanged ? <div className="project-error" role="status">本书偏好已有新版本，本地修改仍保留。
      <button type="button" className="secondary-action" disabled={busy} onClick={() => void reload()}><RotateCcw size={14} />读取最新内容</button>
    </div> : null}
  </section>;
}
