import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, RefreshCw, Save, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { entityChapterHref, entityHref, entityTypeLabels } from "../lib/entity-navigation";
import { errorMessage, getChapterEntityReferences, getCurrentProject, listEntityCards, saveChapterEntityReferences, type ChapterEntityReferences } from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { useCandidateEdits } from "./use-candidate-edits";
import "./entity-references.css";

const signature = (ids: string[]) => JSON.stringify([...ids].sort());

export function ChapterEntityReferencePanel({ chapterId, active, onPendingChange }: {
  chapterId: string; active: boolean; onPendingChange?: (pending: boolean) => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).has("referenceChapter"));
  const [search, setSearch] = useState("");
  const [baseline, setBaseline] = useState<ChapterEntityReferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const edits = useCandidateEdits();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, enabled: active && open });
  const stored = useQuery({
    queryKey: ["chapter-entity-references", project.data?.projectId, chapterId],
    queryFn: () => getChapterEntityReferences(project.data!.projectId, chapterId),
    enabled: active && open && Boolean(project.data), retry: false,
  });
  const cards = useQuery({ queryKey: ["entity-cards", true], queryFn: () => listEntityCards(true),
    enabled: active && open && Boolean(project.data), retry: false });
  const busy = saving || reloading;
  const pending = edits.dirty || busy;
  useUnsavedChangesGuard(pending, "本章参考资料有未保存修改或进行中的操作。");
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  useEffect(() => {
    if (stored.data && !edits.dirty && !busy && (!baseline || stored.data.version > baseline.version)) {
      setBaseline(stored.data);
      edits.discard(chapterId);
    }
  }, [baseline, busy, chapterId, edits.dirty, edits.discard, stored.data]);
  const savedIds = (baseline?.entities ?? []).map((card) => card.entity.id);
  const ids: string[] = JSON.parse(edits.entries[chapterId]?.value ?? signature(savedIds));
  const failed = project.isError || stored.isError || cards.isError;
  const ready = baseline && cards.isSuccess && !failed && project.data?.projectId === baseline.projectId;
  const items = (cards.data ?? []).filter((card) => card.entity.projectId === project.data?.projectId
    && (card.entity.lifecycleStatus === "ACTIVE" || ids.includes(card.entity.id))
    && [card.revision.name, ...card.revision.aliases].join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const remoteChanged = baseline && stored.data && stored.data.version > baseline.version;

  function toggle(id: string) {
    edits.edit(chapterId, signature(ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]), signature(savedIds));
    setNotice(null);
  }

  async function save() {
    if (!ready || busy) return;
    const submitted = signature(ids);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveChapterEntityReferences({ projectId: baseline.projectId, chapterId,
        expectedVersion: baseline.version, entityIds: JSON.parse(submitted) });
      setBaseline(next);
      edits.acknowledge(chapterId, submitted, signature(next.entities.map((card) => card.entity.id)));
      client.setQueryData(["chapter-entity-references", next.projectId, chapterId], next);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["entity-chapters"] }),
        client.invalidateQueries({ queryKey: ["ai-proposals", chapterId] }),
      ]);
      setNotice("本章参考资料已保存。");
    } catch (cause) {
      setError(errorMessage(cause));
      void stored.refetch();
    } finally { setSaving(false); }
  }

  async function reload() {
    if (busy || edits.dirty && !window.confirm("放弃未保存的参考资料选择并读取最新版本吗？")) return;
    setReloading(true);
    try {
      const result = await stored.refetch();
      if (result.isError) throw result.error;
      if (result.data) { setBaseline(result.data); edits.discard(chapterId); setError(null); setNotice(null); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setReloading(false); }
  }

  return <details className="chapter-entity-references" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><BookOpenText size={14} />本章参考资料{baseline ? <span>{ids.length} / 8</span> : null}{pending ? <small>待保存</small> : null}</summary>
    {open ? <div>
      {failed ? <p className="project-error" role="alert">{errorMessage(project.error ?? stored.error ?? cards.error)}
        <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : cards.isError ? cards.refetch() : stored.refetch())}><RefreshCw size={14} />重试</button></p>
        : !project.isPending && !project.data ? <p role="alert">未打开来源项目。</p>
        : !ready ? <p role="status">正在读取参考资料…</p> : null}
      {ready ? <>
        <label className="entity-reference-search"><Search size={14} /><input aria-label="筛选本章参考资料" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称或别名" /></label>
        <div className="entity-reference-list">
          {items.map(({ entity, revision }) => <div className="entity-reference-row" key={entity.id}>
            <label><input type="checkbox" checked={ids.includes(entity.id)}
              disabled={reloading || !ids.includes(entity.id) && (ids.length >= 8 || entity.lifecycleStatus !== "ACTIVE")}
              onChange={() => toggle(entity.id)} />
              <span><strong>{revision.name}</strong><small>{entityTypeLabels[entity.entityType]} · 修订 {revision.revision}{entity.lifecycleStatus === "ARCHIVED" ? " · 已归档" : ""}</small></span></label>
            <a href={entityHref(entity.id, baseline.projectId, entityChapterHref(chapterId, baseline.projectId))} title={`查看${revision.name}`} aria-label={`查看${revision.name}`}><BookOpenText size={14} /></a>
          </div>)}
          {!items.length ? <p>没有匹配的资料。</p> : null}
        </div>
        <div className="entity-reference-actions">
          <button type="button" className="primary-action" disabled={busy || !edits.dirty} onClick={() => void save()}><Save size={14} />{saving ? "保存中…" : "保存参考资料"}</button>
          {edits.dirty || remoteChanged ? <button type="button" className="secondary-action" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />读取最新关联</button> : null}
        </div>
        {remoteChanged ? <p role="status">关联已有新版本，本地选择仍保留。</p> : null}
      </> : null}
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    </div> : null}
  </details>;
}
