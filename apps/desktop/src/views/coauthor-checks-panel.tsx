import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ListChecks, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createCoauthorSourceCheck, errorMessage, getCoauthorSourceCheck, getCoauthorCheckNotes, listCoauthorSourceChecks,
  type CoauthorScope, type CoauthorSourceCheck,
} from "../lib/tauri-client";

const kinds = { MANUSCRIPT: "正式正文", PLAN: "规划记录", ENTITY: "有效设定卡" };
const assessments: Record<string, string> = { RELEVANT: "相关", IRRELEVANT: "不相关", UNCERTAIN: "待核对" };

function CheckNotes({ scope, id, sourceKey, stale, unverified }: {
  scope: CoauthorScope; id: string; sourceKey: string; stale: boolean; unverified: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const notes = useQuery({
    queryKey: ["coauthor-checks", scope.projectId, scope.sessionId, "notes", id, sourceKey, offset],
    queryFn: () => getCoauthorCheckNotes({ scope, id, key: sourceKey, offset }),
    enabled: open, retry: false,
  });
  return <details className="coauthor-check-notes" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>分段分析笔记</summary>
    {open && <>
      {notes.isPending && <p role="status">正在读取分析笔记…</p>}
      {notes.error && <p role="alert" className="project-error">分析笔记无法核实：{errorMessage(notes.error)}</p>}
      {notes.data && <>
        <p role="status">{notes.isError || unverified ? "以下为上次笔记，当前有效性未核实。"
          : stale || notes.data.stale ? "原依据失效，以下分析仅作历史记录。" : "阶段分析，未经作者确认为正式事实。"}</p>
        <p>{notes.data.totalNotes} 段笔记 · 分析覆盖 {notes.data.notedChars} 字</p>
        {!notes.data.notes.length && <p>暂无分段分析笔记。</p>}
        {notes.data.notes.map((note) => <section key={note.id} className="coauthor-check-note">
          <h4>字符 {note.start} 至 {note.end} · v{note.version}</h4>
          <p>{note.analysis}</p>
          {note.quote && <blockquote>{note.quote}</blockquote>}
          {note.questions && <p className="coauthor-note-questions">未决问题：{note.questions}</p>}
        </section>)}
        {(offset > 0 || notes.data.hasMore) && <nav className="coauthor-check-pagination" aria-label="笔记分页">
          <button type="button" className="icon-command" title="上一页笔记" aria-label="上一页笔记"
            disabled={offset === 0 || notes.isFetching} onClick={() => setOffset(Math.max(0, offset - 5))}><ArrowLeft size={16} /></button>
          <span>{notes.data.totalNotes ? offset + 1 : 0} 至 {offset + notes.data.notes.length} / {notes.data.totalNotes}</span>
          <button type="button" className="icon-command" title="下一页笔记" aria-label="下一页笔记"
            disabled={!notes.data.hasMore || notes.isFetching} onClick={() => setOffset(offset + 5)}><ArrowRight size={16} /></button>
        </nav>}
      </>}
    </>}
  </details>;
}

export function CoauthorChecksPanel({ scope, isGenerating, onContinue }: {
  scope: CoauthorScope;
  isGenerating: boolean;
  onContinue: (check: CoauthorSourceCheck) => void;
}) {
  const client = useQueryClient();
  const prefix = ["coauthor-checks", scope.projectId, scope.sessionId];
  const [listOffset, setListOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("全范围查证");
  const [query, setQuery] = useState("");
  const [selectedKinds, setSelectedKinds] = useState(["MANUSCRIPT"]);
  const mounted = useRef(true);
  const posting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const list = useQuery({
    queryKey: [...prefix, "list", listOffset],
    queryFn: () => listCoauthorSourceChecks({ scope, offset: listOffset }),
    retry: false,
  });
  const id = selected || list.data?.checks[0]?.id || "";
  const detail = useQuery({
    queryKey: [...prefix, "detail", id, offset],
    queryFn: () => getCoauthorSourceCheck({ scope, id, offset }),
    enabled: Boolean(id), retry: false,
  });
  const check = detail.data?.check;
  async function create() {
    if (posting.current) return;
    posting.current = true; setCreating(true); setError(null);
    try {
      const page = await createCoauthorSourceCheck({ scope, input: { title, query, kinds: selectedKinds } });
      if (!mounted.current) return;
      client.setQueryData([...prefix, "detail", page.check.id, 0], page);
      setSelected(page.check.id); setOffset(0);
      await client.invalidateQueries({ queryKey: [...prefix, "list"] });
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { posting.current = false; if (mounted.current) setCreating(false); }
  }
  function changeList(value: number) {
    setSelected(""); setOffset(0); setListOffset(value);
  }
  return <section className="coauthor-checks" aria-label="全范围查证">
    <div className="coauthor-check-heading">
      <select aria-label="查证清单" value={id} onChange={(event) => { setSelected(event.target.value); setOffset(0); }}>
        {!id && <option value="">暂无查证清单</option>}
        {selected && !list.data?.checks.some((entry) => entry.id === selected)
          && <option value={selected}>{check?.title ?? selected}</option>}
        {list.data?.checks.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
      </select>
      <button type="button" className="icon-command" aria-label="刷新查证进度" title="刷新查证进度"
        disabled={list.isFetching || detail.isFetching} onClick={() => void client.invalidateQueries({ queryKey: prefix })}>
        <RefreshCw size={16} />
      </button>
    </div>
    {(listOffset > 0 || list.data?.hasMore) && <nav className="coauthor-check-pagination" aria-label="清单分页">
      <button type="button" className="icon-command" title="上一页清单" aria-label="上一页清单"
        disabled={listOffset === 0 || list.isFetching} onClick={() => changeList(Math.max(0, listOffset - 10))}><ArrowLeft size={16} /></button>
      <span>{listOffset + 1} 至 {listOffset + (list.data?.checks.length ?? 0)}</span>
      <button type="button" className="icon-command" title="下一页清单" aria-label="下一页清单"
        disabled={!list.data?.hasMore || list.isFetching} onClick={() => changeList(listOffset + 10)}><ArrowRight size={16} /></button>
    </nav>}
    {(error || list.error || detail.error) && <p role="alert" className="project-error">{error ?? errorMessage(list.error ?? detail.error)}</p>}
    {(list.isPending || (id && detail.isPending)) && <p role="status">正在读取查证范围…</p>}
    {check && <>
      <header className="coauthor-check-summary">
        <h3>{check.title}</h3>
        <p>{check.query}</p>
        <small>{check.kinds.map((kind) => kinds[kind as keyof typeof kinds] ?? kind).join(" / ")} · 清单 {check.id}</small>
        <dl>
          <div><dt>范围</dt><dd>{check.total} 项</dd></div>
          <div><dt>完整读取</dt><dd>{check.read} 项</dd></div>
          <div><dt>完整送达</dt><dd>{check.sent} 项</dd></div>
          <div><dt>已判断</dt><dd>{check.reviewed} 项</dd></div>
          <div><dt>相关</dt><dd>{check.relevant} 项</dd></div>
          <div><dt>待核对</dt><dd>{check.uncertain} 项</dd></div>
        </dl>
        <p role="status">{detail.isFetching ? "正在核对当前进度…" : detail.isError ? "当前进度无法核实，以下为上次记录。"
          : check.complete ? "范围内逐项查证流程已完成，判断仍需作者核对。"
          : check.total === 0 ? "所选范围为空，未形成可查证的资料清单。" : "范围查证尚未完成。"}</p>
        {(check.stale > 0 || check.added > 0 || check.pendingIndexUpdates > 0) && <p role="alert" className="project-error">
          {check.stale} 项原依据失效 · {check.added} 项新增资料 · {check.pendingIndexUpdates} 项索引待更新
        </p>}
        <button type="button" disabled={isGenerating || check.total === 0 || detail.isFetching || detail.isError} onClick={() => onContinue(check)}>
          <ListChecks size={15} />{check.stale || check.added ? "核对范围变化" : "继续查证"}
        </button>
      </header>
      <div aria-label="查证条目">
        {detail.data?.entries.map((entry) => <article className="coauthor-check-entry" key={entry.key}>
          <header><strong>{entry.title}</strong><span>{entry.stale ? "原依据失效" : entry.assessment ? assessments[entry.assessment] : entry.sentComplete ? "原文已送达，待判断" : "未完成"}</span></header>
          <small>{entry.key}</small>
          <p>读取 {entry.readChars} / {entry.totalChars ?? "未知"} 字 · 送达 {entry.sentChars} 字 · 续查位置 {entry.nextOffset}</p>
          {entry.stale && entry.assessment && <small>原判断：{assessments[entry.assessment]}，不计入当前完成进度。</small>}
          {entry.reason && <p>{entry.reason}</p>}
          {entry.quote && <blockquote>{entry.quote}</blockquote>}
          {entry.lastError && <p role="alert" className="project-error">{entry.lastError}</p>}
          <details><summary>来源修订</summary><small>{entry.revision}</small></details>
          <CheckNotes key={`${scope.projectId}:${scope.sessionId}:${id}:${entry.key}`} scope={scope} id={id}
            sourceKey={entry.key} stale={entry.stale} unverified={detail.isError || detail.isFetching} />
        </article>)}
      </div>
      <nav className="coauthor-check-pagination" aria-label="条目分页">
        <button type="button" className="icon-command" title="上一页条目" aria-label="上一页条目" disabled={offset === 0 || detail.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 20))}><ArrowLeft size={16} /></button>
        <span>{check.total ? offset + 1 : 0} 至 {offset + (detail.data?.entries.length ?? 0)} / {check.total}</span>
        <button type="button" className="icon-command" title="下一页条目" aria-label="下一页条目" disabled={!detail.data?.hasMore || detail.isFetching}
          onClick={() => setOffset(offset + 20)}><ArrowRight size={16} /></button>
      </nav>
    </>}
    <details className="coauthor-check-create">
      <summary>新建查证清单</summary>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label>清单标题<input aria-label="清单标题" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>查证问题<textarea aria-label="查证问题" maxLength={2000} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <fieldset><legend>资料范围</legend>
          {Object.entries(kinds).map(([kind, label]) => <label key={kind}>
            <input type="checkbox" checked={selectedKinds.includes(kind)} onChange={(event) => setSelectedKinds((previous) =>
              event.target.checked ? [...previous, kind] : previous.filter((entry) => entry !== kind))} />{label}
          </label>)}
        </fieldset>
        <button type="submit" disabled={creating || !title.trim() || !query.trim() || !selectedKinds.length}><Plus size={15} />创建清单</button>
      </form>
    </details>
  </section>;
}
