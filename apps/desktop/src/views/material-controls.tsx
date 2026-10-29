import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { enqueueChapterSummaryRefresh, enqueueProjectSettingSummaryRefresh, errorMessage, getCurrentProject,
  rebuildSummaryMaterial, setSummaryMaterialLifecycle, upsertSummaryMaterial, upsertWritingCard,
  type SummaryMaterial, type WritingCard } from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { useJobs } from "../lib/jobs-query";
import { summaryIdentity } from "../lib/content-taxonomy";
import { AiWorkspaceLink, useInAiWorkspace } from "./content-identity";

export const automaticSummary = (item: SummaryMaterial) => item.generationMode.startsWith("EXTRACTIVE_AUTO");
export function summaryLabel(item: SummaryMaterial) {
  if (automaticSummary(item)) return summaryIdentity(item).subtype;
  return `参考摘要 · ${{ CHAPTER: "章节", CHARACTER: "人物", SETTING: "设定" }[item.kind]}`;
}
export const summaryStatus = (item: SummaryMaterial) => item.lifecycleStatus === "ACTIVE" ? "有效"
  : item.lifecycleStatus === "CANDIDATE" ? "待确认" : "已过期";

export function MaterialEditor({ kind, projectId: initialProjectId, summary: initialSummary, card: initialCard, onSaved, onCancel, onStateChange }: {
  kind: "SUMMARY" | "CARD"; projectId: string; summary?: SummaryMaterial; card?: WritingCard;
  onSaved: (id: string) => void; onCancel: () => void;
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const [summary] = useState(initialSummary);
  const [card] = useState(initialCard);
  const [projectId] = useState(initialProjectId);
  const client = useQueryClient();
  const [content, setContent] = useState(summary?.content ?? card?.content ?? "");
  const [title, setTitle] = useState(card?.title ?? "");
  const [summaryKind, setSummaryKind] = useState<SummaryMaterial["kind"]>(summary?.kind ?? "CHAPTER");
  const [sourceVersion, setSourceVersion] = useState(summary?.sourceVersion ?? card?.sourceVersion ?? "");
  const [cardType, setCardType] = useState<WritingCard["cardType"]>(card?.cardType ?? "STYLE_RULE");
  const [scope, setScope] = useState(card?.scope ?? "PROJECT");
  const [enabled, setEnabled] = useState(card?.enabled ?? true);
  const [sortText, setSortText] = useState(String(card?.sortOrder ?? 0));
  const sortOrder = sortText.trim() ? Number(sortText) : NaN;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const copy = Boolean(summary && automaticSummary(summary));
  const dirty = content !== (summary?.content ?? card?.content ?? "") || title !== (card?.title ?? "")
    || summaryKind !== (summary?.kind ?? "CHAPTER") || sourceVersion !== (summary?.sourceVersion ?? card?.sourceVersion ?? "")
    || cardType !== (card?.cardType ?? "STYLE_RULE") || scope !== (card?.scope ?? "PROJECT")
    || enabled !== (card?.enabled ?? true) || sortText !== String(card?.sortOrder ?? 0);
  const sortValid = Number.isSafeInteger(sortOrder);
  const canSave = !busy && Boolean(content.trim()) && (kind !== "CARD" || Boolean(title.trim()) && sortValid)
    && (dirty || copy || !summary && !card);
  useEffect(() => { onStateChange?.({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useUnsavedChangesGuard(dirty || busy, "参考资料有尚未保存的修改。");
  function cancel() {
    if (busy || dirty && !window.confirm("放弃尚未保存的资料修改吗？")) return;
    onCancel();
  }
  async function save() {
    if (inFlight.current || !canSave) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if ((await getCurrentProject())?.projectId !== projectId) throw new Error("作品已切换，未保存资料。");
      let id: string;
      if (kind === "SUMMARY") {
        const result = await upsertSummaryMaterial({
          ...(summary ?? { sourceId: null, precision: "L0", createdAt: "", updatedAt: "" }),
          id: !summary || copy ? crypto.randomUUID() : summary.id, projectId, kind: summaryKind,
          sourceVersion: sourceVersion || null, content: content.trim(),
          precision: copy ? "L0" : summary?.precision ?? "L0",
          generationMode: copy || !summary ? "MANUAL_REFERENCE" : summary.generationMode,
          lifecycleStatus: copy || !summary ? "ACTIVE" : summary.lifecycleStatus,
        });
        id = result.id;
      } else {
        const result = await upsertWritingCard({
          ...(card ?? { createdAt: "", updatedAt: "" }), id: card?.id || crypto.randomUUID(), projectId,
          title: title.trim(), content: content.trim(), sourceVersion: sourceVersion || null,
          cardType, scope, enabled, sortOrder,
        });
        id = result.id;
      }
      await Promise.all([client.invalidateQueries({ queryKey: [kind === "SUMMARY" ? "summary-materials" : "writing-cards"] }),
        client.invalidateQueries({ queryKey: [kind === "SUMMARY" ? "summary-material" : "writing-card"] })]);
      onSaved(id);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <form className="library-form" onSubmit={(event) => { event.preventDefault(); void save(); }}
    onKeyDown={(event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.nativeEvent.isComposing) return;
      event.preventDefault(); event.stopPropagation(); void save();
    }}>
    <fieldset disabled={busy} className="entity-import-lock library-form">
      {kind === "SUMMARY" ? <label>关联内容<select aria-label="关联内容" value={summaryKind} onChange={(event) => setSummaryKind(event.target.value as typeof summaryKind)}>
        <option value="CHAPTER">章节</option><option value="CHARACTER">人物</option><option value="SETTING">设定</option>
      </select></label> : <>
        <label>标题<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>卡片类型<select aria-label="卡片类型" value={cardType} onChange={(event) => setCardType(event.target.value as typeof cardType)}>
          <option value="STYLE_RULE">风格规则</option><option value="TECHNIQUE">写作技巧</option>
        </select></label>
      </>}
      <label>{kind === "SUMMARY" ? "摘要内容" : "卡片内容"}<textarea autoFocus={kind === "SUMMARY"} aria-label={kind === "SUMMARY" ? "摘要内容" : "卡片内容"} rows={8} value={content} onChange={(event) => setContent(event.target.value)} /></label>
      {kind === "CARD" ? <label className="library-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此卡片</label> : null}
      <details className="library-advanced"><summary>高级信息{kind === "CARD" && !sortValid ? " · 排序无效" : ""}</summary>
        <label>来源标识<input value={sourceVersion} readOnly={copy} onChange={(event) => setSourceVersion(event.target.value)} /></label>
        {kind === "CARD" ? <><label>作用范围<input value={scope} onChange={(event) => setScope(event.target.value)} /></label>
          <label>排序<input type="number" step={1} value={sortText} aria-invalid={!sortValid} onChange={(event) => setSortText(event.target.value)} /></label>
          {!sortValid ? <p className="project-error" role="alert">排序需填写有效整数。</p> : null}</> : null}
      </details>
    </fieldset>
    {error ? <p role="alert" className="project-error">{error}</p> : null}
    <div className="library-actions"><span className="library-meta" role="status">{busy ? "正在保存…" : dirty ? "有未保存修改" : "尚无新修改"}</span>
      <button type="submit" className="primary-action" disabled={!canSave}>
      <Save size={15} />{busy ? "保存中…" : copy ? "另存为参考摘要" : kind === "SUMMARY" ? "保存摘要" : "保存卡片"}</button>
      <button type="button" className="secondary-action" disabled={busy} onClick={cancel}>取消</button></div>
  </form>;
}

export function SummaryActions({ item, onBusyChange }: { item: SummaryMaterial; onBusyChange?: (busy: boolean) => void }) {
  const aiWorkspace = useInAiWorkspace();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [refreshId, setRefreshId] = useState<string | null>(null);
  const jobs = useJobs({ enabled: automaticSummary(item) });
  const pendingJob = jobs.data?.find((job) => {
    if (job.status !== "QUEUED" && job.status !== "RUNNING") return false;
    if (item.generationMode === "EXTRACTIVE_AUTO_SETTINGS") return job.jobType === "REFRESH_PROJECT_SETTING_SUMMARY";
    if (item.generationMode !== "EXTRACTIVE_AUTO" || job.jobType !== "REFRESH_CHAPTER_SUMMARY") return false;
    try { return JSON.parse(job.payload).chapterId === item.sourceId; } catch { return false; }
  });
  const refreshJob = jobs.data?.find((job) => job.id === refreshId);
  const refreshPending = Boolean(pendingJob || refreshId && (!refreshJob || refreshJob.status === "QUEUED" || refreshJob.status === "RUNNING"));
  useEffect(() => { if (!refreshId && pendingJob) setRefreshId(pendingJob.id); }, [pendingJob, refreshId]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!refreshJob || refreshJob.status === "QUEUED" || refreshJob.status === "RUNNING") return;
    if (refreshJob.status === "SUCCEEDED") {
      setNotice("摘要已重新生成");
      void client.invalidateQueries({ queryKey: ["summary-materials"] });
      void client.invalidateQueries({ queryKey: ["summary-material"] });
    } else setError(refreshJob.errorSummary ?? (refreshJob.status === "FAILED" ? "摘要生成失败，可重新提交。" : "摘要生成已取消。"));
    setRefreshId(null);
  }, [client, refreshJob]);
  useUnsavedChangesGuard(busy, "摘要操作正在提交。");
  async function run(action: () => Promise<unknown>, message: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if ((await getCurrentProject())?.projectId !== item.projectId) throw new Error("作品已切换，未提交摘要操作。");
      await action();
      await Promise.all([client.invalidateQueries({ queryKey: ["summary-materials"] }),
        client.invalidateQueries({ queryKey: ["summary-material"] }), client.invalidateQueries({ queryKey: ["jobs"] })]);
      setNotice(message);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const automatic = automaticSummary(item);
  const refresh = item.generationMode === "EXTRACTIVE_AUTO" && item.sourceId
    ? () => enqueueChapterSummaryRefresh(item.sourceId!)
    : item.generationMode === "EXTRACTIVE_AUTO_SETTINGS" ? enqueueProjectSettingSummaryRefresh : null;
  if (!aiWorkspace) return automatic ? <AiWorkspaceLink
    target={{ projectId: item.projectId, workflow: "materials", targetId: item.id, materialKind: "SUMMARY" }}>
    去共创更新{summaryLabel(item)}
  </AiWorkspaceLink> : null;
  return <>
    <div className="library-actions">
      {automatic ? refresh ? <button type="button" className="secondary-action" disabled={busy || refreshPending}
        onClick={() => void run(async () => { const job = await refresh(); setRefreshId(job.id); }, "重新生成已加入后台队列")}><RefreshCw size={15} />{refreshPending ? "生成中…" : "重新生成"}</button>
        : <span className="library-meta">随正文保存更新</span>
        : <button type="button" className="secondary-action" disabled={busy} onClick={() => {
          if (item.lifecycleStatus === "STALE" && !window.confirm("手工恢复只确认这份摘要可用，不会重新生成或更新来源版本。继续吗？")) return;
          void run(() => setSummaryMaterialLifecycle(item.id, item.lifecycleStatus === "ACTIVE" ? "STALE" : "ACTIVE"),
            item.lifecycleStatus === "ACTIVE" ? "摘要已标记过期" : "摘要已设为有效");
        }}>{item.lifecycleStatus === "ACTIVE" ? "标记过期" : item.lifecycleStatus === "CANDIDATE" ? "确认为有效" : "手工恢复有效"}</button>}
      <details className="library-advanced"><summary>更多操作</summary>
        {automatic ? <button type="button" className="secondary-action" disabled={busy || refreshPending} onClick={() => {
          if (!window.confirm("将这份自动摘要转为手工参考并确认有效？此操作不会更新内容或来源版本，也不代表自动记忆已重新生成。")) return;
          void run(() => rebuildSummaryMaterial(item.id), "已转为手工参考");
        }}>转为手工参考</button> : item.lifecycleStatus !== "CANDIDATE" ? <button type="button" className="secondary-action" disabled={busy}
          onClick={() => void run(() => setSummaryMaterialLifecycle(item.id, "CANDIDATE"), "摘要已转为待确认")}>转为待确认</button> : null}
        {automatic && item.lifecycleStatus === "ACTIVE" ? <button type="button" className="secondary-action" disabled={busy || refreshPending}
          onClick={() => void run(() => setSummaryMaterialLifecycle(item.id, "STALE"), "摘要已标记过期")}>标记过期</button> : null}
      </details>
    </div>{notice ? <p role="status" className="project-notice">{notice}</p> : null}{error ? <p role="alert" className="project-error">{error}</p> : null}
    {jobs.isError && refreshId ? <p role="alert">无法读取生成进度。<button type="button" onClick={() => void jobs.refetch()}>重试</button><a href="/jobs">后台任务</a></p> : null}
  </>;
}
