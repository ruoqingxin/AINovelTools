import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, GitCompareArrows, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  applyCoauthorBranchDecision, errorMessage, getCoauthorBranchDecision, listCoauthorBranchDecisionAdoptions,
  listCoauthorBranchDecisions, prepareCoauthorBranchDecision, searchCoauthorDecisions,
  type CoauthorBranchDecisionAdoption, type CoauthorDecisionMemory, type CoauthorScope,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";

const statuses: Record<string, string> = { CHOSEN: "已选择", REJECTED: "已否定", OPEN: "待定", WITHDRAWN: "已撤回" };
function Memory({ value, showQuote = true }: { value: CoauthorDecisionMemory; showQuote?: boolean }) {
  return <div className="coauthor-decision-snapshot">
    <strong>{value.decision.topic}</strong>
    <small>{statuses[value.decision.status] ?? value.decision.status} · v{value.decision.version}</small>
    <pre>{value.decision.content}</pre>
    <small>别名：{value.aliases.join("、") || "无"}</small>
    <small>决定标识：{value.decision.id}</small>
    {showQuote && value.quote && <blockquote>{value.quote}</blockquote>}
  </div>;
}

function DecisionPicker({ scope, sourceId, label, disabled, onSelect }: {
  scope: CoauthorScope; sourceId?: string; label: string; disabled: boolean;
  onSelect: (memory: CoauthorDecisionMemory | null) => void;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const page = useQuery({
    queryKey: ["coauthor-branch-decision-picker", scope.projectId, scope.sessionId, sourceId ?? "local", query, offset],
    queryFn: () => sourceId ? listCoauthorBranchDecisions({ scope, sourceSessionId: sourceId, query, offset })
      : searchCoauthorDecisions({ scope, query, offset }), retry: false,
  });
  const clear = () => { setSelected(""); onSelect(null); };
  return <section aria-label={label}>
    <h4>{label}</h4>
    <form className="coauthor-run-picker" onSubmit={(event) => {
      event.preventDefault(); if (disabled) return; clear(); setOffset(0);
      if (input.trim() === query && offset === 0) void page.refetch();
      setQuery(input.trim());
    }}>
      <input aria-label={`搜索${label}`} value={input} maxLength={2000} disabled={disabled}
        onChange={(event) => setInput(event.target.value)} />
      <button className="icon-command" title={`搜索${label}`} aria-label={`搜索${label}按钮`} disabled={disabled || page.isFetching}><Search size={16} /></button>
      <button type="button" className="icon-command" title={`刷新${label}`} aria-label={`刷新${label}`}
        disabled={disabled || page.isFetching} onClick={() => { clear(); void page.refetch(); }}><RefreshCw size={16} /></button>
    </form>
    {page.isPending && <p role="status">正在读取决定…</p>}
    {page.error && <p role="alert" className="project-error">{label}无法核实：{errorMessage(page.error)}</p>}
    <fieldset disabled={disabled || page.isFetching || page.isError} className="coauthor-decision-options">
      <legend>{label}选择</legend>
      {!sourceId && <label><input type="radio" name={label} checked={!selected}
        onChange={() => { clear(); }} />新建当前决定</label>}
      {page.data?.memories.map((memory) => <label key={memory.decision.id}>
        <input type="radio" name={label} checked={selected === memory.decision.id} onChange={() => {
          setSelected(memory.decision.id); onSelect(memory);
        }} />
        <span>{memory.decision.topic} · {statuses[memory.decision.status] ?? memory.decision.status} · v{memory.decision.version}</span>
      </label>)}
    </fieldset>
    {page.data?.memories.length === 0 && !page.isError && !page.isFetching && <p>此页没有决定。</p>}
    {(offset > 0 || page.data?.hasMore) && <nav className="coauthor-check-pagination" aria-label={`${label}分页`}>
      <button type="button" className="icon-command" title={`上一页${label}`} aria-label={`上一页${label}`}
        disabled={disabled || offset === 0 || page.isFetching} onClick={() => { clear(); setOffset(Math.max(0, offset - 16)); }}><ArrowLeft size={16} /></button>
      <span>第 {offset / 16 + 1} 页</span>
      <button type="button" className="icon-command" title={`下一页${label}`} aria-label={`下一页${label}`}
        disabled={disabled || !page.data?.hasMore || page.isFetching || page.isError}
        onClick={() => { clear(); setOffset(offset + 16); }}><ArrowRight size={16} /></button>
    </nav>}
  </section>;
}

export function CoauthorBranchDecisions({ scope, sourceId, isGenerating, parentBusy, onBusyChange, onApplied }: {
  scope: CoauthorScope; sourceId: string; isGenerating: () => boolean;
  parentBusy: boolean;
  onBusyChange: (busy: boolean) => void; onApplied: () => Promise<void>;
}) {
  const confirm = useConfirmAction();
  const client = useQueryClient();
  const [source, setSource] = useState<CoauthorDecisionMemory | null>(null);
  const [target, setTarget] = useState<CoauthorDecisionMemory | null>(null);
  const [preview, setPreview] = useState<CoauthorBranchDecisionAdoption | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [pickerVersion, setPickerVersion] = useState(0);
  const history = useQuery({
    queryKey: ["coauthor-branch-decision-adoptions", scope.projectId, scope.sessionId, offset],
    queryFn: () => listCoauthorBranchDecisionAdoptions({ scope, offset }), enabled: historyOpen, retry: false,
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function act(action: () => Promise<void>) {
    if (busyRef.current || parentBusy) return;
    busyRef.current = true; setBusy(true); onBusyChange(true); setError(null);
    try { await action(); } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  }
  const refreshHistory = () => { void client.invalidateQueries({ queryKey: ["coauthor-branch-decision-adoptions", scope.projectId, scope.sessionId] }); };
  async function prepare() {
    if (!source) return;
    await act(async () => {
      setPreview(null);
      if (isGenerating()) throw new Error("请先结束当前生成，再准备采用决定。");
      const result = await prepareCoauthorBranchDecision({ scope, input: {
        sourceSessionId: sourceId, sourceDecisionId: source!.decision.id, sourceVersion: source!.decision.version,
        targetDecisionId: target?.decision.id ?? null, expectedVersion: target?.decision.version ?? 0,
      } });
      if (mounted.current) setPreview(result);
      refreshHistory();
    });
  }
  async function apply() {
    if (!preview || preview.status !== "PENDING") return;
    const value = preview;
    await act(async () => {
      if (isGenerating()) throw new Error("当前仍在生成，旧预览暂不能采用。");
      const beforeStatus = value.before ? statuses[value.before.decision.status] : "不存在";
      if (!await confirm({
        title: "采用分支决定",
        message: `来源「${value.branch.title}」的「${value.source.decision.topic}」v${value.source.decision.version}。`
          + `当前「${value.after.decision.topic}」从${beforeStatus}变为${statuses[value.after.decision.status]}：${value.after.decision.content}。`
          + "仅更新这一条当前讨论决定；不修改工作稿、正式资料或其他决定。",
        confirmLabel: "确认采用决定",
      }) || !mounted.current) return;
      if (isGenerating()) throw new Error("确认期间已启动生成，请结束后重新核对。");
      let applied: CoauthorBranchDecisionAdoption;
      try { applied = await applyCoauthorBranchDecision({ scope, id: value.id }); }
      catch (cause) {
        const actual = await getCoauthorBranchDecision({ scope, id: value.id }).catch(() => null);
        if (actual?.status !== "APPLIED") throw new Error(`${errorMessage(cause)}。未确认采用成功，原预览保留，请重新核对版本。`);
        applied = actual;
      }
      refreshHistory();
      void client.invalidateQueries({ queryKey: ["coauthor-branch-decision-picker", scope.projectId, scope.sessionId] });
      if (!mounted.current) return;
      setPreview(applied); setSource(null); setTarget(null); setPickerVersion((version) => version + 1);
      await onApplied();
    });
  }
  const locked = busy || parentBusy;
  return <section className="coauthor-branch-decisions" aria-label="分支决定对照与采用">
    {sourceId ? <>
      <div className="coauthor-diff">
        <DecisionPicker key={`source:${sourceId}:${pickerVersion}`} scope={scope} sourceId={sourceId} label="来源分支决定" disabled={locked}
          onSelect={(memory) => { setSource(memory); setPreview(null); }} />
        <DecisionPicker key={`target:${pickerVersion}`} scope={scope} label="当前讨论决定" disabled={locked}
          onSelect={(memory) => { setTarget(memory); setPreview(null); }} />
      </div>
      <p className="coauthor-scope-note">主题与别名相似不代表同一规则。更新已有决定保留其主题与别名；新建采用来源主题与别名。正式资料与稿件不变。</p>
      {(source || target) && <div className="coauthor-diff" aria-label="所选决定对照">
        <section><h4>来源</h4>{source ? <Memory value={source} /> : <p>未选择来源决定</p>}</section>
        <section><h4>当前</h4>{target ? <Memory value={target} /> : <p>新建当前决定</p>}</section>
      </div>}
      <button disabled={locked || !source} onClick={() => void prepare()}><GitCompareArrows size={16} />准备决定采用预览</button>
    </> : <p>选择一个直接分支以对照决定。</p>}
    {error && <p role="alert" className="project-error">{error}</p>}
    {preview && <section aria-label="决定采用预览" className="coauthor-change-review">
      <h3>{preview.status === "APPLIED" ? "决定采用回执" : "决定采用前后"} · {preview.branch.title}</h3>
      <details><summary>来源决定及原话 · v{preview.source.decision.version}</summary><Memory value={preview.source} /></details>
      <div className="coauthor-diff">
        <section><h4>采用前</h4>{preview.before ? <Memory value={preview.before} /> : <p>不存在，确认后新建</p>}</section>
        <section><h4>采用后</h4><Memory value={preview.after} showQuote={preview.status === "APPLIED"} /></section>
      </div>
      {preview.status === "APPLIED" ? <p role="status">已采用为决定 v{preview.after.decision.version}；此为历史回执，当前可能已有后续修订。</p>
        : <button className="primary-action" disabled={locked} onClick={() => void apply()}><Check size={16} />确认采用到当前讨论</button>}
    </section>}
    <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
      <summary>分支决定采用记录</summary>
      {historyOpen && <>
        {history.isPending && <p role="status">正在读取决定采用记录…</p>}
        {history.error && <p role="alert" className="project-error">决定采用记录无法核实：{errorMessage(history.error)}</p>}
        {history.data?.adoptions.length === 0 && !history.isFetching && !history.isError && <p>此页没有决定采用记录。</p>}
        {history.data?.adoptions.map((item) => <article className="coauthor-source" key={item.id}>
          <strong>{item.topic}</strong>
          <small>{item.sourceTitle} · {item.status === "APPLIED" ? "已采用" : "待核对"} · {statuses[item.decisionStatus]} · 来源 v{item.sourceVersion}</small>
          <button disabled={locked || history.isFetching || history.isError} onClick={() => void act(async () => {
            const value = await getCoauthorBranchDecision({ scope, id: item.id });
            if (mounted.current) setPreview(value);
          })}>查看决定采用记录</button>
        </article>)}
        {(offset > 0 || history.data?.hasMore) && <nav className="coauthor-check-pagination" aria-label="决定采用记录分页">
          <button className="icon-command" title="上一页决定采用记录" aria-label="上一页决定采用记录"
            disabled={locked || offset === 0 || history.isFetching} onClick={() => setOffset(Math.max(0, offset - 10))}><ArrowLeft size={16} /></button>
          <span>第 {offset / 10 + 1} 页</span>
          <button className="icon-command" title="下一页决定采用记录" aria-label="下一页决定采用记录"
            disabled={locked || !history.data?.hasMore || history.isFetching || history.isError} onClick={() => setOffset(offset + 10)}><ArrowRight size={16} /></button>
        </nav>}
        <button className="icon-command" title="刷新决定采用记录" aria-label="刷新决定采用记录"
          disabled={locked || history.isFetching} onClick={() => void history.refetch()}><RefreshCw size={16} /></button>
      </>}
    </details>
  </section>;
}
