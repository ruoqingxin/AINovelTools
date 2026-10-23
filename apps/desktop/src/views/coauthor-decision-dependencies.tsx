import { ArrowLeft, ArrowRight, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  errorMessage, searchCoauthorDecisions, type CoauthorChangeSet, type CoauthorDecision,
  type CoauthorDecisionDependencyInput, type CoauthorDecisionsPage, type CoauthorScope,
} from "../lib/tauri-client";

export const decisionStatuses: Record<string, string> = { CHOSEN: "已选择", REJECTED: "已否定", OPEN: "待定", WITHDRAWN: "已撤回" };
export function sameDecision(before: CoauthorDecision, current: CoauthorDecision | null) {
  return current !== null && (["id", "version", "topic", "content", "status", "sourceMessageId"] as const)
    .every((key) => before[key] === current[key]);
}
export function hasStaleDecisionDependencies(changes: CoauthorChangeSet, selected: string[]) {
  return !changes.decisionDependencies || changes.decisionDependencies.some((entry) =>
    entry.itemIds.some((id) => selected.includes(id)) && !sameDecision(entry.decision, entry.current));
}

export function DecisionDependenciesReview({ changes, selected }: { changes: CoauthorChangeSet; selected: string[] }) {
  const historical = changes.status === "COMMITTED" || changes.status === "DISCARDED";
  return <section className="coauthor-decision-dependencies" aria-label="讨论决定依赖核对">
    <h4>讨论决定依赖</h4>
    {!changes.decisionDependencies ? <p role="alert">{historical
      ? "此历史方案未记录决定依赖，原记录保留；不能据此推断当时已核对或当前仍有效。"
      : "旧方案未记录决定依赖核对信息，不能直接采用，请重新准备。"}</p>
      : changes.decisionDependencies.length === 0 ? <p>未声明讨论决定依赖，不代表没有隐含依赖或语义矛盾。</p>
        : changes.decisionDependencies.map((entry) => <article className="coauthor-source" key={entry.decision.id}>
          <strong>{entry.decision.topic}</strong>
          <small>决定标识：{entry.decision.id}</small>
          <small>依赖项：{entry.itemIds.map((id) => changes.items.find((item) => item.id === id)?.document.title ?? id).join("、")}</small>
          <div className="coauthor-diff">
            <section><h4>准备时 · v{entry.decision.version} · {decisionStatuses[entry.decision.status]}</h4><pre>{entry.decision.content}</pre></section>
            <section><h4>{entry.current ? `当前 · v${entry.current.version} · ${decisionStatuses[entry.current.status]}` : "当前决定不可用"}</h4>
              <pre>{entry.current?.content ?? "无法核对当前身份"}</pre></section>
          </div>
          {!sameDecision(entry.decision, entry.current) && <p className="project-error" role="alert">
            {historical ? "准备时决定与当前不同；此处仅对照历史，不重放采用或改写已提交内容。"
              : entry.itemIds.some((id) => selected.includes(id)) ? "所选变更依赖的决定已变化，须重新核对并准备。"
                : "决定已变化；当前未选其依赖项，不阻止其他独立项目。"}
          </p>}
        </article>)}
  </section>;
}

export function DecisionDependencyPicker({ scope, value, hasSetting, disabled, onChange }: {
  scope: CoauthorScope; value: CoauthorDecisionDependencyInput[]; hasSetting: boolean; disabled: boolean;
  onChange: (value: CoauthorDecisionDependencyInput[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CoauthorDecisionsPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  async function load(text: string, start: number) {
    const request = ++epoch.current; setBusy(true); setError(null);
    try {
      const result = await searchCoauthorDecisions({ scope, query: text, offset: start });
      if (request === epoch.current) { setPage(result); setQuery(text); setOffset(start); }
    } catch (cause) { if (request === epoch.current) setError(errorMessage(cause)); }
    finally { if (request === epoch.current) setBusy(false); }
  }
  useEffect(() => {
    if (open) void load("", 0);
    return () => { epoch.current++; };
  }, [scope.projectId, scope.sessionId, open]);
  function toggle(decision: CoauthorDecision, itemId: string, checked: boolean) {
    const existing = value.find((entry) => entry.decisionId === decision.id);
    const itemIds = checked ? [...(existing?.itemIds ?? []), itemId] : existing!.itemIds.filter((id) => id !== itemId);
    onChange([...value.filter((entry) => entry.decisionId !== decision.id),
      ...(itemIds.length ? [{ decisionId: decision.id, version: decision.version, itemIds }] : [])]);
  }
  return <details className="coauthor-rule-picker" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>依赖的讨论决定 · {value.length} 条</summary>
    {value.map((entry) => <div className="coauthor-rule-selection" key={entry.decisionId}>
      <small>{entry.decisionId} · v{entry.version} · {entry.itemIds.map((id) => id === "draft" ? "当前工作稿" : "新设定").join("、")}</small>
      <button type="button" className="icon-command" title="移除此决定依赖" aria-label={`移除决定依赖 ${entry.decisionId}`}
        disabled={disabled} onClick={() => onChange(value.filter((item) => item !== entry))}><X size={14} /></button>
    </div>)}
    {open && <>
      <div className="coauthor-run-picker">
        <input aria-label="搜索依赖决定" value={input} disabled={disabled || busy} maxLength={2000}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!disabled && !busy) void load(input.trim(), 0); } }} />
        <button type="button" className="icon-command" title="搜索依赖决定" aria-label="搜索依赖决定按钮"
          disabled={disabled || busy} onClick={() => void load(input.trim(), 0)}><Search size={16} /></button>
        <button type="button" className="icon-command" title="刷新依赖决定" aria-label="刷新依赖决定"
          disabled={disabled || busy} onClick={() => void load(query, offset)}><RefreshCw size={16} /></button>
      </div>
      {busy && <p role="status">正在读取当前决定…</p>}
      {error && <p role="alert" className="project-error">决定目录无法核实：{error}</p>}
      {page?.memories.map(({ decision }) => {
        const selected = value.find((entry) => entry.decisionId === decision.id);
        const outdated = selected !== undefined && selected.version !== decision.version;
        return <article className="coauthor-source" key={decision.id}>
          <strong>{decision.topic}</strong><small>{decisionStatuses[decision.status]} · v{decision.version}</small><p>{decision.content}</p>
          {outdated && <p role="alert">已选 v{selected.version}，当前为 v{decision.version}；请重新核对。</p>}
          {outdated && <button type="button" disabled={disabled || busy || Boolean(error)} onClick={() =>
            onChange(value.map((entry) => entry === selected ? { ...entry, version: decision.version } : entry))}>重新选取此决定</button>}
          <fieldset disabled={disabled || busy || Boolean(error) || outdated || (!selected && value.length >= 32)} className="coauthor-decision-options">
            <legend>依赖此决定的变更项</legend>
            {["draft", ...(hasSetting ? ["setting"] : [])].map((id) => <label key={id}>
              <input type="checkbox" checked={selected?.itemIds.includes(id) ?? false}
                onChange={(event) => toggle(decision, id, event.target.checked)} />{decision.topic} → {id === "draft" ? "当前工作稿" : "新设定"}
            </label>)}
          </fieldset>
        </article>;
      })}
      {page?.memories.length === 0 && !busy && !error && <p>此页没有决定。</p>}
      {(offset > 0 || page?.hasMore) && <nav className="coauthor-check-pagination" aria-label="依赖决定分页">
        <button type="button" className="icon-command" title="上一页依赖决定" aria-label="上一页依赖决定"
          disabled={disabled || busy || offset === 0} onClick={() => void load(query, Math.max(0, offset - 16))}><ArrowLeft size={16} /></button>
        <span>第 {offset / 16 + 1} 页</span>
        <button type="button" className="icon-command" title="下一页依赖决定" aria-label="下一页依赖决定"
          disabled={disabled || busy || !page?.hasMore || Boolean(error)} onClick={() => void load(query, offset + 16)}><ArrowRight size={16} /></button>
      </nav>}
    </>}
  </details>;
}
