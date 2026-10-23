import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, GitCompareArrows, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  applyCoauthorBranchMerge, compareCoauthorBranch, errorMessage, getCoauthorBranchMerge,
  listCoauthorBranches, listCoauthorBranchMerges, prepareCoauthorBranchMerge,
  type CoauthorBranchComparison, type CoauthorBranchMerge, type CoauthorDocument, type CoauthorScope,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { sameDraft } from "./use-coauthor-draft";

type Range = { start: number; end: number };
function selectedRange(element: HTMLTextAreaElement): Range | null {
  const { value, selectionStart: start, selectionEnd: end } = element;
  const splitsPair = (index: number) => index > 0 && index < value.length
    && /[\uD800-\uDBFF]/.test(value[index - 1]) && /[\uDC00-\uDFFF]/.test(value[index]);
  if (start === end || splitsPair(start) || splitsPair(end)) return null;
  return { start: [...value.slice(0, start)].length, end: [...value.slice(0, end)].length };
}

export function CoauthorBranchesPanel({ scope, getDocument, saveDraft, isGenerating, onApplied }: {
  scope: CoauthorScope;
  getDocument: () => CoauthorDocument;
  saveDraft: () => Promise<CoauthorDocument>;
  isGenerating: () => boolean;
  onApplied: (merge: CoauthorBranchMerge) => Promise<void>;
}) {
  const confirm = useConfirmAction();
  const client = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [sourceId, setSourceId] = useState("");
  const [comparison, setComparison] = useState<CoauthorBranchComparison | null>(null);
  const [sourceRange, setSourceRange] = useState<Range | null>(null);
  const [targetRange, setTargetRange] = useState<Range | null>(null);
  const [mode, setMode] = useState("append");
  const [merge, setMerge] = useState<CoauthorBranchMerge | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const branches = useQuery({
    queryKey: ["coauthor-branches", scope.projectId, scope.sessionId, offset],
    queryFn: () => listCoauthorBranches({ scope, offset }), retry: false,
  });
  const history = useQuery({
    queryKey: ["coauthor-branch-merges", scope.projectId, scope.sessionId, historyOffset],
    queryFn: () => listCoauthorBranchMerges({ scope, offset: historyOffset }), enabled: historyOpen, retry: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [scope.projectId, scope.sessionId]);
  async function act(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const currentMatches = (document: CoauthorDocument) => getDocument().version === document.version
    && sameDraft(getDocument(), document);
  async function compare() {
    await act(async () => {
      setComparison(null); setMerge(null); setSourceRange(null); setTargetRange(null);
      if (isGenerating()) throw new Error("请先停止生成或等待完成，再比较分支。");
      const saved = await saveDraft();
      if (!mounted.current) return;
      if (!currentMatches(saved)) throw new Error("保存期间工作稿仍在变化，请重新比较。");
      const result = await compareCoauthorBranch({ scope, sourceSessionId: sourceId });
      if (!mounted.current) return;
      if (!currentMatches(result.currentDocument)) throw new Error("比较期间工作稿已变化，请重新比较。");
      setComparison(result);
      setSourceRange({ start: 0, end: [...result.sourceDocument.content].length });
    });
  }
  async function prepare() {
    if (!comparison || !sourceRange) return;
    await act(async () => {
      setMerge(null);
      if (isGenerating() || !currentMatches(comparison.currentDocument)) throw new Error("工作稿或任务已变化，请重新比较。");
      const total = [...comparison.currentDocument.content].length;
      const target = mode === "append" ? { start: total, end: total }
        : mode === "replace" ? { start: 0, end: total } : targetRange;
      if (!target) throw new Error("当前稿没有有效目标选区。");
      const result = await prepareCoauthorBranchMerge({ scope, input: {
        sourceSessionId: comparison.sourceDocument.sessionId,
        expectedVersion: comparison.currentDocument.version, sourceVersion: comparison.sourceDocument.version,
        sourceStart: sourceRange.start, sourceEnd: sourceRange.end, targetStart: target.start, targetEnd: target.end,
      } });
      if (mounted.current) setMerge(result);
      void client.invalidateQueries({ queryKey: ["coauthor-branch-merges", scope.projectId, scope.sessionId] });
    });
  }
  async function apply() {
    if (!merge || merge.status !== "PENDING") return;
    const preview = merge;
    await act(async () => {
      if (isGenerating() || !currentMatches(preview.before)) throw new Error("当前工作稿已变化，请重新比较和准备合并。");
      if (!await confirm({
        title: "合并分支文字",
        message: `从「${preview.branch.title}」v${preview.source.version} 的字符 ${preview.sourceStart} 至 ${preview.sourceEnd}，`
          + `替换当前工作稿 v${preview.before.version} 的字符 ${preview.targetStart} 至 ${preview.targetEnd}。`
          + "仅生成一份新的工作稿修订；讨论决定、正式设定与其他章节不合并。",
        confirmLabel: "确认合并文字",
      }) || !mounted.current) return;
      if (isGenerating() || !currentMatches(preview.before)) throw new Error("确认期间工作稿或任务已变化，旧合并确认已失效。");
      let applied: CoauthorBranchMerge;
      try { applied = await applyCoauthorBranchMerge({ scope, id: preview.id }); }
      catch (cause) {
        const actual = await getCoauthorBranchMerge({ scope, id: preview.id }).catch(() => null);
        if (actual?.status !== "APPLIED") throw new Error(`${errorMessage(cause)}。合并状态需重新核对，原预览已保留。`);
        applied = actual;
      }
      if (!mounted.current) return;
      setMerge(applied);
      await onApplied(applied);
      void client.invalidateQueries({ queryKey: ["coauthor-branch-merges", scope.projectId, scope.sessionId] });
    });
  }
  function branchPage(value: number) {
    setOffset(value); setSourceId(""); setComparison(null); setMerge(null); setSourceRange(null); setTargetRange(null);
  }
  return <div className="coauthor-branches">
    <div className="coauthor-run-picker">
      <select aria-label="对照分支" value={sourceId} disabled={busy || branches.isFetching || branches.isError}
        onChange={(event) => { setSourceId(event.target.value); setComparison(null); setMerge(null); }}>
        <option value="">选择直接分支</option>
        {branches.data?.branches.map((branch) => <option key={branch.sessionId} value={branch.sessionId}>
          {branch.relationship === "PARENT" ? "父分支" : "子分支"} · {branch.title}
        </option>)}
      </select>
      <button type="button" className="icon-command" title="刷新分支目录" aria-label="刷新分支目录"
        disabled={busy || branches.isFetching} onClick={() => void branches.refetch()}><RefreshCw size={16} /></button>
      <button type="button" disabled={!sourceId || busy || branches.isFetching || branches.isError}
        onClick={() => void compare()}><GitCompareArrows size={16} />比较分支</button>
    </div>
    {branches.isPending && <p role="status">正在读取分支目录…</p>}
    {branches.error && <p role="alert" className="project-error">分支目录无法核实：{errorMessage(branches.error)}</p>}
    {branches.data?.branches.length === 0 && !branches.isFetching && !branches.isError && <p>当前讨论没有直接父分支或子分支。</p>}
    {(offset > 0 || branches.data?.hasMore) && <nav className="coauthor-check-pagination" aria-label="分支目录分页">
      <button className="icon-command" aria-label="上一页分支" title="上一页分支" disabled={busy || offset === 0 || branches.isFetching}
        onClick={() => branchPage(Math.max(0, offset - 20))}><ArrowLeft size={16} /></button>
      <span>第 {offset / 20 + 1} 页</span>
      <button className="icon-command" aria-label="下一页分支" title="下一页分支" disabled={busy || !branches.data?.hasMore || branches.isFetching || branches.isError}
        onClick={() => branchPage(offset + 20)}><ArrowRight size={16} /></button>
    </nav>}
    {error && <p role="alert" className="project-error">{error}</p>}
    {comparison && <section aria-label="分支稿件对照">
      <h3>{comparison.branch.title}</h3>
      <details><summary>继承起点 · v{comparison.baseDocument.version}</summary>
        <pre className="coauthor-review-text">{comparison.baseDocument.content || "空白工作稿"}</pre>
      </details>
      <div className="coauthor-diff">
        <section><h4>当前工作稿 · v{comparison.currentDocument.version}</h4>
          <textarea aria-label="合并目标稿" readOnly value={comparison.currentDocument.content}
            disabled={busy} onSelect={(event) => { if (!busyRef.current) { setTargetRange(selectedRange(event.currentTarget)); setMerge(null); } }} />
        </section>
        <section><h4>分支工作稿 · v{comparison.sourceDocument.version}</h4>
          <textarea aria-label="合并来源稿" readOnly value={comparison.sourceDocument.content}
            disabled={busy} onSelect={(event) => { if (!busyRef.current) { setSourceRange(selectedRange(event.currentTarget)); setMerge(null); } }} />
          <small>{sourceRange ? `来源字符 ${sourceRange.start} 至 ${sourceRange.end}` : "来源选区为空"}</small>
        </section>
      </div>
      <fieldset disabled={busy} className="coauthor-merge-mode"><legend>合并位置</legend>
        {[["append", "追加至末尾"], ["selection", "替换当前选区"], ["replace", "替换全文"]].map(([value, label]) =>
          <label key={value}><input type="radio" name={`merge-mode-${scope.sessionId}`} checked={mode === value}
            onChange={() => { setMode(value); setMerge(null); }} />{label}</label>)}
      </fieldset>
      {mode === "selection" && <p>{targetRange ? `目标字符 ${targetRange.start} 至 ${targetRange.end}` : "目标选区为空"}</p>}
      {comparison.sourceDocument.kind !== comparison.currentDocument.kind && <p role="alert">工作稿类型不同，不能直接合并文字。</p>}
      <button disabled={busy || !sourceRange || sourceRange.start === sourceRange.end
        || (mode === "selection" && !targetRange) || comparison.sourceDocument.kind !== comparison.currentDocument.kind}
        onClick={() => void prepare()}><GitCompareArrows size={16} />准备合并预览</button>
    </section>}
    {merge && <section className="coauthor-change-review" aria-label="分支合并预览">
      <h3>{merge.status === "APPLIED" ? "合并回执" : "合并前后"} · {merge.branch.title}</h3>
      <small>来源 v{merge.source.version} · 字符 {merge.sourceStart} 至 {merge.sourceEnd} ·
        目标 v{merge.before.version} · 字符 {merge.targetStart} 至 {merge.targetEnd}</small>
      <div className="coauthor-diff">
        <section><h4>合并前 · v{merge.before.version}</h4><pre aria-label="分支合并前">{merge.before.content}</pre></section>
        <section><h4>合并后 · v{merge.after.version}</h4><pre aria-label="分支合并后">{merge.after.content}</pre></section>
      </div>
      <p>仅合并工作稿文字；讨论决定、正式内容与其他分支未采用，规则依赖仍待核对。</p>
      {merge.status === "APPLIED" ? <p role="status">已合并为工作稿 v{merge.after.version}，当前稿件可能已有后续编辑。</p>
        : <button className="primary-action" disabled={busy} onClick={() => void apply()}><Check size={16} />确认合并到工作稿</button>}
    </section>}
    <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
      <summary>分支合并记录</summary>
      {historyOpen && <>
        {history.isPending && <p role="status">正在读取合并记录…</p>}
        {history.error && <p role="alert" className="project-error">合并记录无法核实：{errorMessage(history.error)}</p>}
        {history.data?.merges.length === 0 && !history.isFetching && !history.isError && <p>此页没有合并记录。</p>}
        {history.data?.merges.map((item) => <article className="coauthor-source" key={item.id}>
          <strong>{item.sourceTitle}</strong><small>{item.status === "APPLIED" ? "已合并" : "待核对"} · 来源 v{item.sourceVersion} · 目标 v{item.beforeVersion}</small>
          <button disabled={busy || history.isFetching || history.isError} onClick={() => void act(async () => {
            const value = await getCoauthorBranchMerge({ scope, id: item.id });
            if (mounted.current) { setComparison(null); setMerge(value); }
          })}>查看合并记录</button>
        </article>)}
        {(historyOffset > 0 || history.data?.hasMore) && <nav className="coauthor-check-pagination" aria-label="合并记录分页">
          <button className="icon-command" aria-label="上一页合并记录" title="上一页合并记录" disabled={busy || historyOffset === 0 || history.isFetching}
            onClick={() => setHistoryOffset(Math.max(0, historyOffset - 10))}><ArrowLeft size={16} /></button>
          <span>第 {historyOffset / 10 + 1} 页</span>
          <button className="icon-command" aria-label="下一页合并记录" title="下一页合并记录" disabled={busy || !history.data?.hasMore || history.isFetching || history.isError}
            onClick={() => setHistoryOffset(historyOffset + 10)}><ArrowRight size={16} /></button>
        </nav>}
        <button className="icon-command" title="刷新合并记录" aria-label="刷新合并记录" disabled={busy || history.isFetching}
          onClick={() => void history.refetch()}><RefreshCw size={16} /></button>
      </>}
    </details>
  </div>;
}
